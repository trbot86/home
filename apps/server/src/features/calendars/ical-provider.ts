import { Worker } from 'node:worker_threads';
import { createRequire as calendarRequire } from 'node:module';
import { isTimeZone } from '@our-place/contracts';
import {
  CalendarProviderError,
  calendarWindow,
  type CalendarEventSnapshot,
  type CalendarWindow,
} from './provider.js';

/** A fixed Google HTTPS origin avoids turning private calendar URLs into an arbitrary fetch proxy. */
export function googleIcalUrl(value: string): string {
  try {
    const u = new URL(value);
    if (
      u.protocol !== 'https:' ||
      u.hostname !== 'calendar.google.com' ||
      u.port ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !/^\/calendar\/ical\/[^/]+\/(?:private-[a-zA-Z0-9]+|public)\/basic\.ics$/.test(u.pathname)
    )
      throw new Error();
    return u.href;
  } catch {
    throw new CalendarProviderError('calendar_unavailable');
  }
}

// Parse and expand untrusted recurrence rules off the server thread, with a time and memory ceiling.
const parser = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const ical=require(workerData.module);
const text=(v,n)=>String(v && typeof v==='object' && 'val' in v?v.val:v??'').slice(0,n);
try {
  if(!/^BEGIN:VCALENDAR\s*$/m.test(workerData.body) || !/END:VCALENDAR\s*$/.test(workerData.body)) throw Error();
  const data=ical.sync.parseICS(workerData.body), events=[];
  const zone=text(data.vcalendar?.['WR-TIMEZONE'],100)||'UTC';
  for(const event of Object.values(data)) {
    if(event?.type!=='VEVENT' || event.status==='CANCELLED') continue;
    if(!event.start || !event.uid) throw Error();
    for(const i of ical.expandRecurringEvent(event,{from:new Date(workerData.window.from),to:new Date(workerData.window.until-1),expandOngoing:true})) {
      const e=i.event;
      if(e.status==='CANCELLED' || +i.start>=workerData.window.until || +i.end<workerData.window.from) continue;
      if(events.length>=5000) throw Error();
      const key=i.start.toISOString();
      events.push({eventId:text(event.uid,1900)+':'+key,instanceKey:key,recurringEventId:i.isRecurring?text(event.uid,1900):null,
        providerVersion:String(e.sequence??0),title:text(i.summary,1000),description:text(e.description,20000),location:text(e.location,4000),
        sourceUrl:null,status:e.status==='TENTATIVE'?'tentative':'confirmed',participation:null,
        visibility:['PRIVATE','CONFIDENTIAL','PUBLIC'].includes(e.class)?e.class.toLowerCase():'default',busy:e.transparency!=='TRANSPARENT',
        timing:i.isFullDay?{kind:'all_day',startDate:i.start.toISOString().slice(0,10),endDate:i.end.toISOString().slice(0,10)}:
        {kind:'timed',startAt:+i.start,endAt:+i.end,timeZone:i.start.tz||zone,endUnspecified:!e.end}});
    }
  }
  parentPort.postMessage({events,timeZone:zone,window:workerData.window});
} catch { parentPort.postMessage(null); }
`;
export function parseIcal(
  body: string,
  window: CalendarWindow,
  signal?: AbortSignal,
): Promise<CalendarEventSnapshot> {
  calendarWindow(window);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CalendarProviderError('provider_unavailable'));
      return;
    }
    const worker = new Worker(parser, {
      eval: true,
      workerData: { body, window, module: calendarRequire(import.meta.url).resolve('node-ical') },
      resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 },
    });
    const fail = () => finish(null);
    const timer = setTimeout(fail, 5000);
    function finish(result: CalendarEventSnapshot | null) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', fail);
      void worker.terminate();
      if (!result || !isTimeZone(result.timeZone))
        reject(new CalendarProviderError('invalid_provider_response'));
      else {
        for (const event of result.events)
          if (event.timing.kind === 'timed' && !isTimeZone(event.timing.timeZone))
            event.timing.timeZone = result.timeZone;
        resolve(result);
      }
    }
    signal?.addEventListener('abort', fail, { once: true });
    worker.once('message', finish);
    worker.once('error', fail);
    worker.once('exit', (code) => {
      if (code) fail();
    });
  });
}
export class IcalProvider {
  constructor(private readonly request: typeof fetch = fetch) {}
  async read(url: string, window: CalendarWindow, signal?: AbortSignal): Promise<CalendarEventSnapshot> {
    try {
      const response = await this.request(googleIcalUrl(url), {
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]),
        headers: { accept: 'text/calendar' },
      });
      if (!response.ok || !response.body) throw new CalendarProviderError('calendar_unavailable');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 5 * 1024 * 1024) throw new CalendarProviderError('calendar_limit');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return await parseIcal(Buffer.concat(chunks).toString('utf8'), window, signal);
    } catch (error) {
      throw error instanceof CalendarProviderError
        ? error
        : new CalendarProviderError('provider_unavailable');
    }
  }
}
