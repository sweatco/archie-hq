// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'evalite/config';
export default defineConfig({ maxConcurrency: 1, testTimeout: Number(process.env.REPLAY_TIMEOUT_MS ?? 240_000) + 10_000 });
