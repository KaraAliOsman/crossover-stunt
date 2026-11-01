import fc from 'fast-check';
import { expect, it } from 'vitest';
import { normalizeChat } from '../src/twitch/normalize.js';

it('attributes a Shared Chat copy to its origin and uses its source message key', () => {
  const channels = { A: 'channel-a', B: 'channel-b' } as const;
  const original = normalizeChat(
    { broadcaster_user_id: 'channel-a', chatter_user_id: 'viewer-1', message_id: 'original' },
    channels,
    100,
  );
  const copy = normalizeChat(
    {
      broadcaster_user_id: 'channel-b',
      chatter_user_id: 'viewer-1',
      message_id: 'copy',
      source_broadcaster_user_id: 'channel-a',
      source_message_id: 'original',
    },
    channels,
    100,
  );
  expect(copy).toEqual(original);
  expect(copy?.side).toBe('A');
  expect(
    normalizeChat(
      {
        broadcaster_user_id: 'channel-b',
        chatter_user_id: 'viewer-1',
        message_id: 'other',
        source_broadcaster_user_id: 'third-channel',
      },
      channels,
      100,
    ),
  ).toBeNull();
});

it('treats explicit null Shared Chat fields as a local message', () => {
  expect(
    normalizeChat(
      {
        broadcaster_user_id: 'channel-b',
        chatter_user_id: 'viewer-2',
        message_id: 'local',
        source_broadcaster_user_id: null,
        source_message_id: null,
      },
      { A: 'channel-a', B: 'channel-b' },
      5,
    ),
  ).toEqual({
    messageKey: 'local',
    chatterId: 'viewer-2',
    originBroadcasterId: 'channel-b',
    side: 'B',
    receivedAtMs: 5,
    simulated: false,
  });
});

it('property: a relayed copy always normalizes like its original; unknown origins never count', () => {
  const id = fc.string({ minLength: 1, maxLength: 12 });
  fc.assert(
    fc.property(
      fc.uniqueArray(id, { minLength: 3, maxLength: 3 }),
      id,
      fc.uniqueArray(id, { minLength: 2, maxLength: 2 }),
      fc.boolean(),
      ([a, b, third], chatter, [sourceId, copyId], fromA) => {
        if (a === undefined || b === undefined || third === undefined) return;
        if (sourceId === undefined || copyId === undefined) return;
        const channels = { A: a, B: b };
        const [origin, relay] = fromA ? [a, b] : [b, a];
        const original = normalizeChat(
          { broadcaster_user_id: origin, chatter_user_id: chatter, message_id: sourceId },
          channels,
          1,
        );
        const copy = normalizeChat(
          {
            broadcaster_user_id: relay,
            chatter_user_id: chatter,
            message_id: copyId,
            source_broadcaster_user_id: origin,
            source_message_id: sourceId,
          },
          channels,
          1,
        );
        expect(copy).toEqual(original);
        expect(original?.side).toBe(fromA ? 'A' : 'B');
        expect(
          normalizeChat(
            {
              broadcaster_user_id: relay,
              chatter_user_id: chatter,
              message_id: copyId,
              source_broadcaster_user_id: third,
              source_message_id: sourceId,
            },
            channels,
            1,
          ),
        ).toBeNull();
      },
    ),
  );
});

it('normalizes the server-only chatter login without changing Shared Chat origin', () => {
  expect(
    normalizeChat(
      {
        broadcaster_user_id: 'b',
        chatter_user_id: 'person',
        chatter_user_login: ' NightBot ',
        message_id: 'copy',
        source_broadcaster_user_id: 'a',
        source_message_id: 'original',
      },
      { A: 'a', B: 'b' },
      1,
    ),
  ).toMatchObject({ chatterLogin: 'nightbot', side: 'A', messageKey: 'original' });
});
