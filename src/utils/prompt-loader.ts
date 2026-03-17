/**
 * Prompt Template Loader
 *
 * Loads prompt templates from markdown files and interpolates variables
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to prompts directory (relative to this file: src/utils -> prompts)
const PROMPTS_DIR = join(__dirname, '..', '..', 'prompts');

/**
 * Load a prompt template from file and interpolate variables
 *
 * @param templateName - Name of the template file (without .md extension)
 * @param variables - Object with variable values to interpolate
 * @returns Interpolated prompt string
 *
 * @example
 * ```ts
 * const prompt = await loadPrompt('pm-agent', {
 *   TEAM_LIST: '- backend-agent: Senior Rails engineer\n- mobile-agent: Senior React Native engineer',
 *   TEAM_EXPERTISE: '- backend-agent: APIs, databases\n- mobile-agent: Mobile UI/UX'
 * });
 * ```
 */
export async function loadPrompt(
  templateName: string,
  variables: Record<string, string>
): Promise<string> {
  const templatePath = join(PROMPTS_DIR, `${templateName}.md`);
  let template = await readFile(templatePath, 'utf-8');

  // Replace all {{VAR}} patterns with their values
  for (const [key, value] of Object.entries(variables)) {
    const pattern = new RegExp(`{{${key}}}`, 'g');
    template = template.replace(pattern, value);
  }

  return template;
}

/**
 * Load a prompt template from an absolute file path and interpolate variables
 *
 * @param absolutePath - Absolute path to the template file
 * @param variables - Object with variable values to interpolate
 * @returns Interpolated prompt string
 */
export async function loadPromptFromPath(
  absolutePath: string,
  variables: Record<string, string> = {}
): Promise<string> {
  let template = await readFile(absolutePath, 'utf-8');

  for (const [key, value] of Object.entries(variables)) {
    const pattern = new RegExp(`{{${key}}}`, 'g');
    template = template.replace(pattern, value);
  }

  return template;
}
