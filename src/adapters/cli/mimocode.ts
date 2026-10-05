import { createOpenCodeLikeAdapter } from './opencode.js';
import { join, posix } from 'node:path';
import { CLI_MODEL_CHOICES } from './model-choices.js';
import {
  mimocodeCachePath,
  mimocodeConfigPath,
  mimocodeDataPath,
  mimocodeDbPath,
  mimocodeStatePath,
} from '../../services/mimocode-paths.js';

export function createMiMoCodeAdapter(pathOverride?: string) {
  const configRoot = mimocodeConfigPath();
  // Tilde paths are logical home-relative paths; concrete XDG paths use the
  // host separator. Preserve the ~/ form consumed by home-path expansion.
  const configSubpath = (...parts: string[]) => configRoot.startsWith('~/')
    ? posix.join(configRoot, ...parts) : join(configRoot, ...parts);
  return createOpenCodeLikeAdapter(pathOverride, {
    id: 'mimocode',
    defaultBin: 'mimo',
    dataRoot: mimocodeDataPath(),
    authPaths: [
      mimocodeConfigPath(),
      mimocodeDataPath(),
      mimocodeStatePath(),
      mimocodeCachePath(),
    ],
    dbPath: mimocodeDbPath,
    skillsDir: configSubpath('skills'),
    hookConfigPath: configSubpath('plugin', 'botmux-ask.js'),
    modelListArgs: ['models'],
    startupArgs: ['--trust'],
    modelChoices: CLI_MODEL_CHOICES['mimocode'],
  });
}

export const create = createMiMoCodeAdapter;
