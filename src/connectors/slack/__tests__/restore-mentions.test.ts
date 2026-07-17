/**
 * Unit test for restoreMentions — converts the internal `@<ID:Name>` mention
 * marker (and the model's common `<@ID:Name>` drift) into Slack's `<@ID>` syntax
 * on outgoing messages. Regression for task-20260708-1144-wvnrnz, where the
 * bracket-first `<@U…:Name>` form reached Slack unconverted and rendered as raw
 * literal text instead of a mention.
 */

import { describe, it, expect } from 'vitest';
import { restoreMentions } from '../client.js';

describe('restoreMentions', () => {
  it('converts the taught @<ID:Name> form to <@ID>', () => {
    expect(restoreMentions('Thanks @<U03RQQTK1C3:Mikhail Froimson> — appreciated.')).toBe(
      'Thanks <@U03RQQTK1C3> — appreciated.',
    );
  });

  it('converts the drifted <@ID:Name> form (the bug) to <@ID>', () => {
    expect(restoreMentions('Good news <@U03RQQTK1C3:Mikhail Froimson> — ready to merge.')).toBe(
      'Good news <@U03RQQTK1C3> — ready to merge.',
    );
  });

  it('leaves an already-valid <@ID> (no name) untouched', () => {
    expect(restoreMentions('cc <@U03RQQTK1C3> please review')).toBe('cc <@U03RQQTK1C3> please review');
  });

  it('converts multiple mixed-form mentions in one message', () => {
    expect(
      restoreMentions('@<U03RQQTK1C3:Mikhail Froimson> <@U03UR8GV934:Alex Negru> — scoping done'),
    ).toBe('<@U03RQQTK1C3> <@U03UR8GV934> — scoping done');
  });

  it('leaves plain text with no mention markers unchanged', () => {
    expect(restoreMentions('No mentions here, just #6727 and a plan.')).toBe(
      'No mentions here, just #6727 and a plan.',
    );
  });
});
