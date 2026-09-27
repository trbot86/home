import { request } from 'node:http';
import { isAbsolute } from 'node:path';
import { CaptureRequest, OutcomeSchema, isValid, type CommandOutcome } from '@our-place/contracts';
import type { CaptureSink } from './skill.js';

/** A fixed local socket and route; no URL, redirect, host or command comes from Alexa. */
export function createSocketCaptureSink(options: {
  socketPath: string;
  token: string;
  bindingId: string;
  timeoutMs?: number;
}): CaptureSink {
  const timeout = options.timeoutMs ?? 3000;
  if (
    !isAbsolute(options.socketPath) ||
    !/^[A-Za-z0-9_-]{43}$/.test(options.token) ||
    !options.bindingId ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 3000
  )
    throw new Error('Invalid capture transport configuration');
  return async (bindingId, capture): Promise<CommandOutcome> => {
    if (
      bindingId !== options.bindingId ||
      !isValid(CaptureRequest, capture) ||
      capture.destination !== 'inbox'
    )
      throw new Error('Invalid capture');
    const body = JSON.stringify(capture);
    return new Promise((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fail = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        req.destroy();
        reject(new Error('Capture outcome unavailable'));
      };
      const req = request(
        {
          socketPath: options.socketPath,
          path: '/capture/inbox',
          method: 'POST',
          agent: false,
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            !/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')
          ) {
            response.destroy();
            fail();
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 16 * 1024) {
              response.destroy();
              fail();
            } else chunks.push(chunk);
          });
          response.on('error', fail);
          response.on('aborted', fail);
          response.on('end', () => {
            if (finished) return;
            try {
              const outcome: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (
                !isValid(OutcomeSchema, outcome) ||
                ('receipt' in outcome && outcome.receipt.operationId !== capture.operationId)
              )
                return fail();
              finished = true;
              clearTimeout(timer);
              resolve(outcome);
            } catch {
              fail();
            }
          });
        },
      );
      req.on('error', fail);
      timer = setTimeout(fail, timeout);
      // One attempt only. Lost acknowledgements are uncertain, never a newly keyed write.
      req.end(body);
    });
  };
}
