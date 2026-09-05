/**
 * ACP transports. The protocol is identical across all of them — only the pipe
 * differs — so the client is written once against this interface.
 *
 * The DeepSeek Harness backend is a single mode:
 *   deepseek-acp (no args) → StdioTransport   (implemented — see below)
 *
 * `deepseek-acp` needs no subcommand or flags to run as an ACP service: any
 * argv that is not `--setup` / `--version` / `--help` falls through to service
 * mode by design (upstream: "起服务不需要任何参数"). There is no `agent serve`
 * / `agent leader` / `agent headless` equivalent — every session is its own
 * fresh process talking stdio — so `WebSocketTransport` below is dormant
 * infrastructure carried over from this project's Grok Build ancestor, kept
 * in case a future backend can use it, not exercised by the dsh path.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { JsonRpcMessage } from './protocol.ts';

export interface Transport extends EventEmitter {
  /** Emitted per decoded JSON-RPC frame. */
  on(event: 'message', cb: (msg: JsonRpcMessage) => void): this;
  /** Transport-level failure. Not a protocol error. */
  on(event: 'error', cb: (err: Error) => void): this;
  /** Pipe closed. */
  on(event: 'close', cb: (info: { code: number | null; reason?: string }) => void): this;
  /** Diagnostic text (agent stderr). Never protocol data. */
  on(event: 'stderr', cb: (text: string) => void): this;

  send(msg: JsonRpcMessage): void;
  close(): void;
}

/**
 * Splits a byte stream into newline-delimited JSON frames.
 *
 * Kept separate from the transports so it can be unit-tested against recorded
 * captures, and because chunk boundaries land mid-frame constantly in practice —
 * that is the bug that bites every hand-rolled NDJSON reader.
 */
/**
 * Ceiling on a single unterminated line.
 *
 * ACP frames are legitimately large — a `session/load` replay or a big tool
 * output runs to megabytes — so this is generous. But it must exist: an agent
 * emitting a stream with no newline would otherwise grow the buffer until the
 * process died, and the daemon holds every other session.
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export class NdjsonDecoder {
  #buf = '';

  push(
    chunk: string | Buffer,
    onFrame: (msg: JsonRpcMessage) => void,
    onBad?: (line: string, err: Error) => void
  ): void {
    this.#buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    // No newline in sight and past the ceiling: this is not a frame we are ever
    // going to complete. Report and drop, rather than accumulate until the
    // process dies — the daemon holds every other session.
    if (this.#buf.length > MAX_LINE_BYTES && this.#buf.indexOf('\n') === -1) {
      const size = this.#buf.length;
      const head = this.#buf.slice(0, 200);
      this.#buf = '';
      onBad?.(
        head,
        new Error(
          `unterminated ACP line exceeded ${MAX_LINE_BYTES} bytes (${size}) — buffer dropped`
        )
      );
      return;
    }

    let nl: number;
    while ((nl = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (!line) continue;
      try {
        onFrame(JSON.parse(line) as JsonRpcMessage);
      } catch (err) {
        onBad?.(line, err as Error);
      }
    }
  }

  /** Bytes buffered but not yet terminated by a newline. */
  get pending(): string {
    return this.#buf;
  }
}

export interface StdioTransportOptions {
  /** Path to the `deepseek-acp` binary. */
  command?: string;
  /** Extra args forwarded verbatim; anything here still falls through to service mode. */
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * DeepSeek Harness has no `grok agent leader`-style shared backend — every
   * spawned `deepseek-acp` is its own process. These two fields are accepted
   * for interface compatibility with the Grok Build transport this project
   * was derived from, and are never translated into argv or env here; a
   * config file carrying them from that era keeps loading instead of failing.
   * @deprecated no effect on this transport
   */
  useLeader?: boolean;
  /** @deprecated no effect on this transport — see {@link useLeader} */
  leaderSocket?: string;
  /**
   * Model for the spawned session. Unlike Grok Build's `--model` argv flag,
   * `deepseek-acp` has no CLI model switch — it reads `DEEPSEEK_ACP_MODEL`
   * from the child's environment at boot (default `deepseek-v4-flash`), so
   * that is where this value goes. Per-turn model switching is an ACP
   * session-level capability (see the model/reasoning/file-permission
   * selectors in the upstream README) this daemon does not yet drive — a
   * natural next step, tracked as a TODO rather than wired here.
   */
  model?: string;
  /**
   * Held over from the Grok Build transport for interface compatibility.
   * `deepseek-acp` has no spawn-time permission bypass: its sandbox always
   * emits `session/request_permission` for anything outside the session cwd
   * or the system temp dir — which is the whole point of this project's
   * one-tap remote approval — so there is nothing to translate into argv.
   * @deprecated no effect on this transport
   */
  permissionMode?: string;
}

export class StdioTransport extends EventEmitter implements Transport {
  #child: ChildProcessWithoutNullStreams;
  #decoder = new NdjsonDecoder();
  #closed = false;
  /** The argv actually used. Exposed so argument-order bugs are testable. */
  readonly args: string[];

  constructor(opts: StdioTransportOptions = {}) {
    super();
    // No subcommand, no mode flags: `deepseek-acp` with no recognized special
    // flag (`--setup`/`--version`/`--help`) runs as an ACP service on stdio.
    // `opts.args` passes through verbatim for forward compatibility, but there
    // is nothing this transport needs to construct itself.
    const args: string[] = [...(opts.args ?? [])];
    this.args = args;

    // Model selection is env-based for this backend (see StdioTransportOptions.model).
    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    if (opts.model) env.DEEPSEEK_ACP_MODEL = opts.model;

    this.#child = spawn(opts.command ?? 'deepseek-acp', args, {
      cwd: opts.cwd ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.#child.stdout.on('data', (chunk: Buffer) => {
      this.#decoder.push(
        chunk,
        (msg) => this.emit('message', msg),
        (line, err) =>
          this.emit(
            'error',
            new Error(`undecodable ACP frame: ${err.message} :: ${line.slice(0, 200)}`)
          )
      );
    });

    this.#child.stderr.on('data', (chunk: Buffer) => this.emit('stderr', chunk.toString('utf8')));

    // stdin needs its own error handler. An unhandled 'error' on a Node stream
    // is THROWN, so an EPIPE — the agent exited in the window between its death
    // and `close` reaching us — would take down the whole daemon, and with it
    // every other session it holds. Report it as a transport error instead.
    this.#child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      this.#closed = true;
      if (err.code === 'EPIPE') {
        this.emit('error', new Error('agent stdin closed (EPIPE) — the process is gone'));
      } else {
        this.emit('error', err);
      }
    });

    this.#child.on('error', (err) => this.emit('error', err));
    this.#child.on('close', (code) => {
      this.#closed = true;
      this.emit('close', { code });
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  send(msg: JsonRpcMessage): void {
    if (this.#closed) throw new Error('transport closed');
    // `writable` is false the moment the pipe breaks, often before the child's
    // `close` event arrives — check it rather than discovering EPIPE the hard way.
    if (!this.#child.stdin.writable) {
      this.#closed = true;
      throw new Error('transport closed: agent stdin is no longer writable');
    }
    this.#child.stdin.write(JSON.stringify(msg) + '\n');
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    /**
     * Killing a child that never started is not an error worth propagating.
     *
     * `spawn` reports ENOENT asynchronously, so a transport whose agent binary
     * was missing still holds a ChildProcess with no pid. Killing that throws
     * `EINVAL` on Windows (and is a silent no-op on Linux, which is why this
     * went unnoticed). close() is called from shutdown paths and from `catch`
     * blocks, so a throw here replaces the real failure with a confusing one —
     * the same shape as the spawn-ENOENT bug that used to take down the daemon.
     */
    const kill = (signal: 'SIGTERM' | 'SIGKILL') => {
      try {
        this.#child.kill(signal);
      } catch {
        /* never started, or already reaped */
      }
    };
    kill('SIGTERM');
    // Escalate if the agent ignores SIGTERM — otherwise a wedged agent keeps
    // the daemon alive forever on shutdown.
    const t = setTimeout(() => kill('SIGKILL'), 3000);
    t.unref?.();
  }
}

export interface WebSocketTransportOptions {
  url: string;
  /** Bearer token, if the far end wants one. */
  secret?: string;
  headers?: Record<string, string>;
}

/**
 * Generic ACP-over-WebSocket client. Carried over from this project's Grok
 * Build ancestor (`grok agent serve`); `deepseek-acp` has no WebSocket mode of
 * its own, so nothing in the dsh path constructs this today. Left in place —
 * dormant, not deleted — for a future backend that does speak ACP over WS.
 *
 * `ws` is imported lazily so the stdio path — the one actually used — has no
 * runtime dependency at all.
 */
export class WebSocketTransport extends EventEmitter implements Transport {
  #ws: import('ws').WebSocket | null = null;
  #queue: JsonRpcMessage[] = [];
  #closed = false;

  constructor(opts: WebSocketTransportOptions) {
    super();
    void this.#connect(opts);
  }

  async #connect(opts: WebSocketTransportOptions): Promise<void> {
    try {
      const { WebSocket } = await import('ws');
      const headers = { ...opts.headers };
      if (opts.secret) headers['Authorization'] = `Bearer ${opts.secret}`;
      const ws = new WebSocket(opts.url, { headers });
      this.#ws = ws;

      ws.on('open', () => {
        for (const m of this.#queue.splice(0)) ws.send(JSON.stringify(m) + '\n');
      });
      const decoder = new NdjsonDecoder();
      ws.on('message', (data: Buffer | string) => {
        decoder.push(
          typeof data === 'string' ? data : data.toString('utf8'),
          (msg) => this.emit('message', msg),
          (line, err) =>
            this.emit(
              'error',
              new Error(`undecodable ACP frame: ${err.message} :: ${line.slice(0, 200)}`)
            )
        );
      });
      ws.on('error', (err: Error) => this.emit('error', err));
      ws.on('close', (code: number, reason: Buffer) => {
        this.#closed = true;
        this.emit('close', { code, reason: reason?.toString() });
      });
    } catch (err) {
      this.emit('error', err as Error);
    }
  }

  send(msg: JsonRpcMessage): void {
    if (this.#closed) throw new Error('transport closed');
    if (this.#ws && this.#ws.readyState === 1) this.#ws.send(JSON.stringify(msg) + '\n');
    else this.#queue.push(msg);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ws?.close();
  }
}
