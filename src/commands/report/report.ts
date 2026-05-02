import PDFDocument from 'pdfkit'
import { createWriteStream } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, extname, isAbsolute, resolve } from 'path'
import { marked } from 'marked'
import { queryWithModel } from '../../services/api/claude.js'
import type { LocalCommandCall } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import {
  extractTextContent,
  getMessagesAfterCompactBoundary,
} from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

type ReportFormat = 'markdown' | 'html' | 'pdf'

type ReportSkill = {
  label: string
  extension: string
  instruction: string
}

const REPORT_SKILLS: Record<ReportFormat, ReportSkill> = {
  markdown: {
    label: 'Markdown report skill',
    extension: '.md',
    instruction:
      'Write clean Markdown with short sections, direct headings, and no decorative formatting.',
  },
  html: {
    label: 'HTML report skill',
    extension: '.html',
    instruction:
      'Write source Markdown that converts well to HTML: clear hierarchy, compact paragraphs, and no tables unless essential.',
  },
  pdf: {
    label: 'PDF report skill',
    extension: '.pdf',
    instruction:
      'Write source Markdown that reads well in paged PDF form: short paragraphs, concise lists, and stable heading structure.',
  },
}

const FORMAT_ALIASES: Record<string, ReportFormat> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  pdf: 'pdf',
}

const MAX_TRANSCRIPT_CHARS = 90_000
const TRANSCRIPT_HEAD_CHARS = 18_000

export const call: LocalCommandCall = async (args, context) => {
  const parsed = parseReportArgs(args)
  if (parsed.kind === 'help') {
    return { type: 'text', value: usageText() }
  }

  const skill = REPORT_SKILLS[parsed.format]
  const transcript = buildTranscript(context.messages ?? [])
  if (!transcript.trim()) {
    return {
      type: 'text',
      value: 'No session content found to report on.',
    }
  }

  const markdown = await generateReportMarkdown({
    transcript,
    format: parsed.format,
    skill,
    model: context.options.mainLoopModel,
    signal: context.abortController.signal,
  })

  const outputPath = resolveOutputPath(parsed.filename, parsed.format)
  await mkdir(dirname(outputPath), { recursive: true })

  if (parsed.format === 'markdown') {
    await writeFile(outputPath, ensureTrailingNewline(markdown), {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } else if (parsed.format === 'html') {
    await writeFile(outputPath, renderHtml(markdown), {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } else {
    await writePdf(markdown, outputPath)
  }

  return {
    type: 'text',
    value: [
      `Report written to: ${outputPath}`,
      `Format: ${parsed.format}`,
      `Skill: ${skill.label}`,
    ].join('\n'),
  }
}

function parseReportArgs(
  args: string,
): { kind: 'run'; format: ReportFormat; filename?: string } | { kind: 'help' } {
  const tokens = tokenizeArgs(args)
  const first = tokens[0]?.toLowerCase()

  if (!first || first === 'help' || first === '--help' || first === '-h') {
    return first ? { kind: 'help' } : { kind: 'run', format: 'markdown' }
  }

  const explicitFormat = FORMAT_ALIASES[first]
  if (explicitFormat) {
    return {
      kind: 'run',
      format: explicitFormat,
      filename: tokens.slice(1).join(' ') || undefined,
    }
  }

  const inferredFormat = formatFromPath(first)
  if (inferredFormat) {
    return {
      kind: 'run',
      format: inferredFormat,
      filename: tokens.join(' '),
    }
  }

  return { kind: 'help' }
}

function tokenizeArgs(args: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < args.length; i++) {
    const char = args[i]!
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

function usageText(): string {
  return [
    'Usage: /report <markdown|html|pdf> [filename]',
    '',
    'Examples:',
    '/report markdown',
    '/report html session-report.html',
    '/report pdf final-report.pdf',
    '',
    'This is a final-session content report. It does not include usage, token, tool-call, or statistics sections.',
  ].join('\n')
}

function formatFromPath(path: string): ReportFormat | null {
  switch (extname(path).toLowerCase()) {
    case '.md':
    case '.markdown':
      return 'markdown'
    case '.html':
    case '.htm':
      return 'html'
    case '.pdf':
      return 'pdf'
    default:
      return null
  }
}

function resolveOutputPath(
  filename: string | undefined,
  format: ReportFormat,
): string {
  const skill = REPORT_SKILLS[format]
  const rawFilename =
    filename?.trim() ||
    `session-report-${formatTimestamp(new Date())}${skill.extension}`
  const withExtension = normalizeExtension(rawFilename, skill.extension)
  return isAbsolute(withExtension) ? withExtension : resolve(getCwd(), withExtension)
}

function normalizeExtension(filename: string, extension: string): string {
  const current = extname(filename)
  if (!current) return `${filename}${extension}`
  return filename.slice(0, -current.length) + extension
}

function formatTimestamp(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`
}

function buildTranscript(messages: Message[]): string {
  const visibleMessages = getMessagesAfterCompactBoundary(messages)
  const parts: string[] = []

  for (const message of visibleMessages) {
    if (message.type === 'user') {
      const text = userMessageText(message)
      if (text) parts.push(`User:\n${text}`)
      continue
    }

    if (message.type === 'assistant') {
      const text = extractTextContent(message.message.content, '\n').trim()
      if (text && text !== '[No content]') {
        parts.push(`Assistant:\n${text}`)
      }
    }
  }

  return trimTranscript(parts.join('\n\n---\n\n'))
}

function userMessageText(message: Extract<Message, { type: 'user' }>): string {
  const userMessage = message as typeof message & {
    isMeta?: boolean
    isVirtual?: boolean
    toolUseResult?: unknown
  }
  if (
    userMessage.isMeta ||
    userMessage.isVirtual ||
    userMessage.toolUseResult !== undefined
  ) {
    return ''
  }

  const content = message.message.content
  const text =
    typeof content === 'string'
      ? content
      : content
          .filter(
            (block): block is Extract<typeof block, { type: 'text' }> =>
              block.type === 'text',
          )
          .map(block => block.text)
          .join('\n')

  const trimmed = text.trim()
  if (
    !trimmed ||
    trimmed.startsWith('<local-command-') ||
    trimmed.startsWith('<command-')
  ) {
    return ''
  }
  return trimmed
}

function trimTranscript(transcript: string): string {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript

  const head = transcript.slice(0, TRANSCRIPT_HEAD_CHARS)
  const tail = transcript.slice(-(MAX_TRANSCRIPT_CHARS - TRANSCRIPT_HEAD_CHARS))
  return [
    head,
    '[Middle of transcript omitted for report generation context size.]',
    tail,
  ].join('\n\n---\n\n')
}

async function generateReportMarkdown({
  transcript,
  format,
  skill,
  model,
  signal,
}: {
  transcript: string
  format: ReportFormat
  skill: ReportSkill
  model: string
  signal: AbortSignal
}): Promise<string> {
  const result = await queryWithModel({
    systemPrompt: asSystemPrompt([
      'You write final session reports for a user after an AI coding/research session.',
      'Your priority is high content quality, clarity, and faithful reconstruction from the transcript.',
    ]),
    userPrompt: buildReportPrompt({ transcript, format, skill }),
    signal,
    options: {
      model,
      querySource: 'report',
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
      maxOutputTokensOverride: 4096,
      temperatureOverride: 0.2,
    },
  })

  const text = extractTextContent(result.message.content, '\n').trim()
  return stripMarkdownFence(text)
}

function buildReportPrompt({
  transcript,
  format,
  skill,
}: {
  transcript: string
  format: ReportFormat
  skill: ReportSkill
}): string {
  return `Create the final session report.

Selected output format: ${format}
Active prebuilt report skill: ${skill.label}
Format skill instruction: ${skill.instruction}

Content rules:
- Return only Markdown content. Do not wrap it in a code fence.
- No statistics: no token usage, costs, percentages, charts, timing, tool-call counts, or numerical summaries.
- Do not include a "Statistics" section.
- Do not mention tool names or internal implementation details unless the user needs that detail to understand the result.
- Prefer plain language over developer jargon.
- Keep it readable for a non-specialist while preserving the real substance of the session.
- Be concise, but do not omit important work, decisions, constraints, blockers, or next actions.
- Use concrete details from the transcript. Do not invent outcomes or decisions.
- Do not praise the assistant. Write as a neutral session report.

Use these exact sections:
# Session Report
## What This Session Was About
## What Was Handled
## Important Choices
## Current State
## What Still Needs Attention
## Suggested Next Steps

If a section has no real content, write "Nothing specific came up." for that section.

Transcript:
${transcript}`
}

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim()
  const match = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1]!.trim() : trimmed
}

function renderHtml(markdown: string): string {
  const body = marked.parse(markdown, { async: false }) as string
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Session Report</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f5f2;
      --text: #1f2933;
      --muted: #5c6670;
      --border: #d9d6cf;
      --accent: #215c5c;
      --paper: #ffffff;
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      max-width: 860px;
      margin: 32px auto;
      padding: 44px 52px;
      background: var(--paper);
      border: 1px solid var(--border);
    }
    h1, h2 {
      line-height: 1.25;
      letter-spacing: 0;
    }
    h1 {
      margin: 0 0 28px;
      font-size: 32px;
      color: var(--accent);
    }
    h2 {
      margin: 28px 0 10px;
      padding-top: 18px;
      border-top: 1px solid var(--border);
      font-size: 20px;
    }
    p, ul {
      margin: 0 0 14px;
    }
    li {
      margin: 5px 0;
    }
    code {
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 0.92em;
    }
    @media (max-width: 720px) {
      main {
        margin: 0;
        padding: 28px 22px;
        border: 0;
      }
    }
  </style>
</head>
<body>
  <main>
${body}
  </main>
</body>
</html>
`
}

async function writePdf(markdown: string, path: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 54,
      info: {
        Title: 'Session Report',
      },
    })
    const stream = createWriteStream(path)

    stream.on('finish', resolvePromise)
    stream.on('error', reject)
    doc.on('error', reject)

    doc.pipe(stream)
    renderMarkdownToPdf(doc, markdown)
    doc.end()
  })
}

function renderMarkdownToPdf(doc: PDFKit.PDFDocument, markdown: string): void {
  doc.fillColor('#1f2933')

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      doc.moveDown(0.45)
      continue
    }

    if (line.startsWith('# ')) {
      doc.moveDown(0.2)
      doc.font('Helvetica-Bold').fontSize(22).fillColor('#215c5c')
      doc.text(stripInlineMarkdown(line.slice(2)), { lineGap: 4 })
      doc.moveDown(0.8)
      doc.fillColor('#1f2933')
      continue
    }

    if (line.startsWith('## ')) {
      doc.moveDown(0.8)
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#215c5c')
      doc.text(stripInlineMarkdown(line.slice(3)), { lineGap: 2 })
      doc.moveDown(0.35)
      doc.fillColor('#1f2933')
      continue
    }

    if (line.startsWith('### ')) {
      doc.moveDown(0.5)
      doc.font('Helvetica-Bold').fontSize(12)
      doc.text(stripInlineMarkdown(line.slice(4)), { lineGap: 2 })
      doc.moveDown(0.2)
      continue
    }

    const listMatch = line.match(/^[-*]\s+(.*)$/)
    if (listMatch) {
      doc.font('Helvetica').fontSize(10.5).fillColor('#1f2933')
      doc.text(`- ${stripInlineMarkdown(listMatch[1]!)}`, {
        indent: 14,
        hangingIndent: 8,
        lineGap: 2,
      })
      continue
    }

    doc.font('Helvetica').fontSize(10.5).fillColor('#1f2933')
    doc.text(stripInlineMarkdown(line), { lineGap: 2 })
  }
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`
}
