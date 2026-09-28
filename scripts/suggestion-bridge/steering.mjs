import { join } from 'node:path';
import { readJson, writeJson, createOnce } from './journal.mjs';

/** Single supervisor owns dispatch. An uncertain request is never blindly replayed. */
export function steeringMailbox(directory) {
  return {
    async next() {
      const feed = await readJson(join(directory, 'steering-feed.json'));
      for (const message of feed?.messages ?? []) {
        const path = join(directory, 'steering', message.recordId + '.json');
        if (await createOnce(path, { state: 'uncertain', messageId: message.recordId }))
          return { message, path };
      }
      return null;
    },
    async complete(item, state) {
      await writeJson(item.path, { messageId: item.message.recordId, state });
    },
  };
}
