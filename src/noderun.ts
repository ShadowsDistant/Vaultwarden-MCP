import { execFile } from 'node:child_process';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

/**
 * Running a Node script (the Bitwarden CLI, or one of the small dialog and clipboard helpers)
 * without assuming there is a Node executable to run it with.
 *
 * Normally there is: `process.execPath` is node, and the script runs as a child process. Inside
 * Claude Desktop there is not. Its extensions run inside the Electron app itself, so
 * `process.execPath` is the app, and the app refuses to behave as Node (its run-as-node fuse is
 * off). Spawning it just starts, or pokes, the desktop app, and every vault call failed in a few
 * milliseconds with nothing useful in the log. So there the script runs in a worker thread of
 * this process instead, which needs no executable at all.
 *
 * A worker is a fair stand-in for a child here. It gets its own `process.argv`, its own copy of
 * `process.env` (built from scratch by the caller, exactly as for a child), its own stdin, stdout
 * and stderr, and `process.exit()` inside it ends the worker, not this process.
 */

export type RunMode = 'process' | 'worker';

export type RunResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean; error?: string };

export type RunOptions = {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  /** Node to use in process mode. Defaults to this process's own executable. */
  nodeExe?: string;
};

/**
 * Process mode needs a real Node. `VW_MCP_RUNNER` can force either mode, which is how the tests
 * exercise the worker path on an ordinary Node.
 */
export function runMode(nodeExe = process.execPath): RunMode {
  const forced = (process.env.VW_MCP_RUNNER ?? '').trim().toLowerCase();
  if (forced === 'worker' || forced === 'process') return forced;
  if (process.versions.electron && nodeExe === process.execPath) return 'worker';
  return /^node(\.exe)?$/i.test(path.basename(nodeExe)) ? 'process' : 'worker';
}

export function runNodeScript(script: string, opts: RunOptions): Promise<RunResult> {
  const nodeExe = opts.nodeExe ?? process.execPath;
  return runMode(nodeExe) === 'worker' ? inWorker(script, opts) : inProcess(nodeExe, script, opts);
}

function inProcess(nodeExe: string, script: string, opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      nodeExe,
      [script, ...opts.args],
      { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: false, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        if (e?.killed) {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: null, timedOut: true });
          return;
        }
        // A string code is a spawn failure (ENOENT, EACCES), not an exit status.
        if (e && typeof e.code === 'string') {
          resolve({ stdout: '', stderr: stderr ?? '', code: null, timedOut: false, error: `${e.code}: ${e.message}` });
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, timedOut: false });
      },
    );
    if (child.stdin) {
      if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
      // The CLI's readStdin() waits for `end`; without this it hangs until the timeout.
      child.stdin.end();
    }
  });
}

function inWorker(script: string, opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(script, {
        argv: opts.args,
        env: { ...opts.env },
        stdin: true,
        stdout: true,
        stderr: true,
        // The CLI loads a 20 MB bundle and a WASM module; this is room for that, and a ceiling
        // so a runaway call cannot take the whole process down with it.
        resourceLimits: { maxOldGenerationSizeMb: 768 },
      });
    } catch (e) {
      resolve({ stdout: '', stderr: '', code: null, timedOut: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    worker.stdout.setEncoding('utf8');
    worker.stderr.setEncoding('utf8');
    worker.stdout.on('data', (d: string) => (stdout += d));
    worker.stderr.on('data', (d: string) => (stderr += d));

    let ended = 0;
    let onEnded: (() => void) | null = null;
    const ended2 = (): void => {
      ended += 1;
      if (ended >= 2) onEnded?.();
    };
    worker.stdout.on('end', ended2);
    worker.stderr.on('end', ended2);

    const finish = (r: Omit<RunResult, 'stdout' | 'stderr'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Output written just before exit can still be in flight on the worker's streams, so wait
      // for both to end — briefly, since a terminated worker may never end them.
      const done = (): void => resolve({ stdout, stderr, ...r });
      if (ended >= 2) {
        done();
        return;
      }
      const cap = setTimeout(done, 250);
      onEnded = () => {
        clearTimeout(cap);
        done();
      };
    };

    const timer = setTimeout(() => {
      void worker.terminate();
      finish({ code: null, timedOut: true });
    }, opts.timeoutMs);

    worker.on('error', (e) => {
      stderr += `\n${e instanceof Error ? e.message : String(e)}`;
      finish({ code: 1, timedOut: false });
    });
    worker.on('exit', (code) => finish({ code, timedOut: false }));

    if (opts.stdin !== undefined) worker.stdin?.write(opts.stdin);
    worker.stdin?.end();
  });
}
