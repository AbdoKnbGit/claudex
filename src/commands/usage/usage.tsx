import * as React from 'react'
import { useEffect, useState } from 'react'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { Byline } from '../../components/design-system/Byline.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { ProgressBar } from '../../components/design-system/ProgressBar.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Link, Text, useInput } from '../../ink.js'
import {
  fetchAllProviderUsage,
  type ProviderUsageReport,
  type ProviderUsageSnapshot,
  type ProviderUsageStatus,
  type UsageMetric,
} from '../../services/api/providerUsage.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import { formatResetText } from '../../utils/format.js'

export const call: LocalJSXCommandCall = async (onDone) => {
  return <ProviderUsageDialog onDone={onDone} />
}

function ProviderUsageDialog({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const [snapshot, setSnapshot] = useState<ProviderUsageSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const { columns } = useTerminalSize()
  const maxWidth = Math.max(30, Math.min(columns - 4, 96))
  const barWidth = Math.max(12, Math.min(36, maxWidth - 36))

  const refresh = React.useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      setSnapshot(await fetchAllProviderUsage())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useInput((input) => {
    if (input.toLowerCase() === 'r' && !isLoading) {
      void refresh()
    }
  })

  const refreshedAt = snapshot
    ? new Date(snapshot.refreshedAt).toLocaleTimeString()
    : null

  return (
    <Dialog
      title="Usage"
      subtitle={refreshedAt ? `Refreshed ${refreshedAt}` : 'Refreshing...'}
      onCancel={() => onDone()}
      color="permission"
      inputGuide={() => (
        <Byline>
          <Text>r refresh</Text>
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Usage"
            fallback="Esc"
            description="close"
          />
        </Byline>
      )}
    >
      <Box flexDirection="column" gap={1} width={maxWidth}>
        {error ? <Text color="error">Error: {error}</Text> : null}
        {!snapshot && !error ? (
          <Text dimColor>Fetching provider usage...</Text>
        ) : null}
        {snapshot ? (
          <>
            {isLoading ? <Text dimColor>Refreshing...</Text> : null}
            {snapshot.reports.map((report) => (
              <UsageReportRow
                key={report.provider}
                report={report}
                barWidth={barWidth}
              />
            ))}
          </>
        ) : null}
      </Box>
    </Dialog>
  )
}

function UsageReportRow({
  report,
  barWidth,
}: {
  report: ProviderUsageReport
  barWidth: number
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{report.name}</Text>
        <Text dimColor> [{report.source}] </Text>
        <Text color={statusColor(report.status)}>{statusLabel(report.status)}</Text>
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        <Text dimColor>{report.summary}</Text>
        {report.detail ? <Text dimColor>{report.detail}</Text> : null}
        {report.metrics?.map((metric) => (
          <MetricLine
            key={`${report.provider}-${metric.label}`}
            metric={metric}
            barWidth={barWidth}
          />
        ))}
        {report.links?.map((link) => (
          <Text key={link.url} dimColor>
            {link.label}: <Link url={link.url}>{link.url}</Link>
            {link.note ? ` - ${link.note}` : ''}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

function MetricLine({
  metric,
  barWidth,
}: {
  metric: UsageMetric
  barWidth: number
}): React.ReactNode {
  const percent = typeof metric.usedPercent === 'number'
    ? Math.max(0, Math.min(100, metric.usedPercent))
    : null
  const resetText = metric.resetsAt
    ? `Resets ${formatResetText(metric.resetsAt, true, true)}`
    : null

  return (
    <Box flexDirection="column">
      <Text>
        <Text>{metric.label}</Text>
        {metric.summary ? <Text dimColor> - {metric.summary}</Text> : null}
      </Text>
      {percent !== null ? (
        <Box flexDirection="row" gap={1}>
          <ProgressBar
            ratio={percent / 100}
            width={barWidth}
            fillColor="rate_limit_fill"
            emptyColor="rate_limit_empty"
          />
          <Text>{Math.floor(percent)}% used</Text>
        </Box>
      ) : null}
      {metric.detail ? <Text dimColor>{metric.detail}</Text> : null}
      {resetText ? <Text dimColor>{resetText}</Text> : null}
    </Box>
  )
}

function statusLabel(status: ProviderUsageStatus): string {
  switch (status) {
    case 'ok': return 'ok'
    case 'connected': return 'connected'
    case 'not_configured': return 'not configured'
    case 'unsupported': return 'not available'
    case 'error': return 'error'
  }
}

function statusColor(status: ProviderUsageStatus): 'success' | 'warning' | 'error' | undefined {
  switch (status) {
    case 'ok': return 'success'
    case 'connected': return 'success'
    case 'not_configured': return undefined
    case 'unsupported': return 'warning'
    case 'error': return 'error'
  }
}
