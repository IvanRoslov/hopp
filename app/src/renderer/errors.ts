// cleanError gives the message of an error that crossed the bridge:
// ipcRenderer.invoke prefixes main-process errors with the channel name and
// the error's class.
export function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}
