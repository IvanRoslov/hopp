// The entry of the app's commands: `hopp project`, `hopp pipeline` and
// `hopp task`. The hopp CLI runs an unknown `hopp <word>` as the program
// `hopp-<word>`; the app installs those as small scripts that run this file
// with the app's own Node (ELECTRON_RUN_AS_NODE) and the word as the first
// argument.
import { DaemonClient, DaemonError } from '../main/daemon/client';
import { runCli } from './commands';
import { connectShell, homes } from './connect';

// Not passed on to git, gh or hopp.
delete process.env['ELECTRON_RUN_AS_NODE'];

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  const [noun = '', ...args] = process.argv.slice(2);
  const env = process.env;
  const client = new DaemonClient(homes(env).daemonSocket);
  let shell: ReturnType<typeof connectShell> | null = null;
  return runCli(noun, args, {
    shell: async () => (await (shell ??= connectShell(env))).api,
    sessions: () => client.listSessions({ all: true }),
    getSession: async (id) => {
      try {
        return await client.getSession(id);
      } catch (err) {
        if (err instanceof DaemonError && err.status === 404) return null;
        throw err;
      }
    },
    env,
    stdin: readStdin,
    out: (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n'),
    err: (s) => process.stderr.write(s.endsWith('\n') ? s : s + '\n'),
  });
}

main().then(
  (code) => {
    process.exitCode = code;
    // Nothing must keep the process alive after the answer (a store watcher,
    // a kept-alive socket).
    setTimeout(() => process.exit(code), 50).unref();
  },
  (err) => {
    process.stderr.write(`hopp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
