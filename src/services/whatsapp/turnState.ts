let activeWhatsAppTurns = 0

export function beginWhatsAppDrivenTurn(): () => void {
  activeWhatsAppTurns++
  let ended = false
  return () => {
    if (ended) return
    ended = true
    activeWhatsAppTurns = Math.max(0, activeWhatsAppTurns - 1)
  }
}

export function isWhatsAppDrivenTurn(): boolean {
  return activeWhatsAppTurns > 0
}
