export const WINDOWS_PARENT_SHUTDOWN_MESSAGE = 'botmux:parent-shutdown';

/** Only an inherited Node IPC channel can request this. Remember requests
 * during startup until the daemon/dashboard has installed its cleanup handler. */
export function installWindowsParentShutdown(): () => void {
  if (process.platform !== 'win32' || !process.send) return () => {};
  let ready = false;
  let requested = false;
  let dispatched = false;
  const dispatch = () => {
    if (!ready || !requested || dispatched) return;
    dispatched = true;
    process.emit('SIGTERM');
  };
  const request = () => { requested = true; dispatch(); };
  process.on('message', message => {
    if (message === WINDOWS_PARENT_SHUTDOWN_MESSAGE) request();
  });
  // Supervisor loss must not leave independent, untracked child daemons.
  process.on('disconnect', request);
  return () => { ready = true; dispatch(); };
}
