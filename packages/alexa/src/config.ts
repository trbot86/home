import { isAbsolute } from 'node:path';
import { Id, isValid } from '@our-place/contracts';

export type ReceiverConfig = {
  skillId: string;
  alexaUserIds: string[];
  expectedServerEpoch: string;
  captureSocketPath: string;
  captureToken: string;
};
export function parseReceiverConfig(value: unknown): ReceiverConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid receiver config');
  const config = value as Record<string, unknown>;
  const keys = ['skillId', 'alexaUserIds', 'expectedServerEpoch', 'captureSocketPath', 'captureToken'];
  if (
    Object.keys(config).length !== keys.length ||
    !keys.every((key) => key in config) ||
    typeof config.skillId !== 'string' ||
    !/^amzn1\.ask\.skill\.[a-f0-9-]{36}$/.test(config.skillId) ||
    !Array.isArray(config.alexaUserIds) ||
    config.alexaUserIds.length < 1 ||
    config.alexaUserIds.length > 8 ||
    !config.alexaUserIds.every(
      (id) => typeof id === 'string' && id.length > 0 && id.length <= 1000 && !/\s/.test(id),
    ) ||
    new Set(config.alexaUserIds).size !== config.alexaUserIds.length ||
    !isValid(Id, config.expectedServerEpoch) ||
    typeof config.captureSocketPath !== 'string' ||
    !isAbsolute(config.captureSocketPath) ||
    typeof config.captureToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(config.captureToken)
  )
    throw new Error('Invalid receiver config');
  return structuredClone(config) as ReceiverConfig;
}
