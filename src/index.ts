export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export function formatLog(level: LogLevel, message: string): string {
  return `[${level.toUpperCase()}] ${message}`
}
