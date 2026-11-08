import type { ThemeDefinition } from '../tokens.ts';
import { octopusContrast } from './octopus-contrast.ts';
import { octopusDark } from './octopus-dark.ts';
import { octopusLight } from './octopus-light.ts';

/**
 * Every shipped theme. To add one: create `src/theme/themes/<id>.ts` exporting a
 * `ThemeDefinition` and append it here. Nothing else changes (docs/design/THEMING.md).
 */
export const THEMES: readonly ThemeDefinition[] = [octopusDark, octopusLight, octopusContrast];
