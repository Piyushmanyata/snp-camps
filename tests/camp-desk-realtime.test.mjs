/**
 * Behavioural coverage for camp-desk Realtime subscription (#25).
 * Fake channel factory — no React DOM, no live websocket.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetCampDeskTopicSeqForTests,
  campDeskChannelTopic,
  RECONNECTING_INDICATOR,
  subscribeCampDeskRealtime,
} from "../src/lib/camp-desk-realtime.ts";

test.beforeEach(() => {
  __resetCampDeskTopicSeqForTests();
});

function createFakeFactory() {
  /** @type {{ topic: string, handlers: Map<string, Function>, statusCb: Function|null, closed: boolean, channel: object }[]} */
  const channels = [];

  const factory = {
    open(topic) {
      const entry = {
        topic,
        handlers: new Map(),
        statusCb: null,
        closed: false,
        channel: /** @type {object|null} */ (null),
      };
      const channel = {
        on(type, filter, callback) {
          assert.equal(type, "postgres_changes");
          assert.equal(filter.schema, "public");
          assert.equal(filter.table, "patients");
          entry.handlers.set(`${type}:${filter.filter}`, {
            filter,
            callback,
          });
          return channel;
        },
        subscribe(cb) {
          entry.statusCb = cb || null;
          return channel;
        },
      };
      entry.channel = channel;
      channels.push(entry);
      return channel;
    },
    close(channel) {
      const entry = channels.find((c) => c.channel === channel);
      assert.ok(entry, "close called for unknown channel");
      entry.closed = true;
    },
  };

  return {
    factory,
    channels,
    /** @param {number} i */
    emitChange(i = 0, payload = { eventType: "UPDATE" }) {
      const entry = channels[i];
      assert.ok(entry, `channel ${i} missing`);
      for (const { callback } of entry.handlers.values()) {
        callback(payload);
      }
    },
    /** @param {number} i @param {string} status */
    emitStatus(i, status) {
      const entry = channels[i];
      assert.ok(entry?.statusCb, `status callback missing on channel ${i}`);
      entry.statusCb(status);
    },
    openCount() {
      return channels.filter((c) => !c.closed).length;
    },
  };
}

test("RECONNECTING_INDICATOR is the specified desk copy", () => {
  assert.equal(
    RECONNECTING_INDICATOR,
    "Reconnecting — refreshing every 2 minutes",
  );
});

test("subscribe: opens camp-scoped unique topic and postgres filter", () => {
  const fake = createFakeFactory();
  const campId = "camp-aaa";
  subscribeCampDeskRealtime(campId, fake.factory, {
    onRefresh() {},
    onStatus() {},
  });
  assert.equal(fake.channels.length, 1);
  assert.match(
    fake.channels[0].topic,
    new RegExp(`^${campDeskChannelTopic(campId)}:\\d+$`),
  );
  const bound = [...fake.channels[0].handlers.values()][0];
  assert.equal(bound.filter.filter, `camp_id=eq.${campId}`);
  assert.equal(bound.filter.event, "*");
});

test("two subscribers for the same camp get distinct topics", () => {
  const fake = createFakeFactory();
  subscribeCampDeskRealtime("camp-1", fake.factory, {
    onRefresh() {},
    onStatus() {},
  });
  subscribeCampDeskRealtime("camp-1", fake.factory, {
    onRefresh() {},
    onStatus() {},
  });
  assert.equal(fake.channels.length, 2);
  assert.notEqual(fake.channels[0].topic, fake.channels[1].topic);
  assert.ok(
    fake.channels.every((c) => c.topic.startsWith(campDeskChannelTopic("camp-1"))),
  );
});

test("subscribe: message applies onRefresh", () => {
  const fake = createFakeFactory();
  let refreshes = 0;
  subscribeCampDeskRealtime("camp-1", fake.factory, {
    onRefresh() {
      refreshes += 1;
    },
    onStatus() {},
  });
  fake.emitChange(0);
  fake.emitChange(0);
  assert.equal(refreshes, 2);
});

test("unmount teardown closes the channel", () => {
  const fake = createFakeFactory();
  const teardown = subscribeCampDeskRealtime("camp-1", fake.factory, {
    onRefresh() {},
    onStatus() {},
  });
  assert.equal(fake.openCount(), 1);
  teardown();
  assert.equal(fake.openCount(), 0);
});

test("camp-change: ten navigations leave no open channels", () => {
  const fake = createFakeFactory();
  let teardown = () => {};
  for (let i = 0; i < 10; i += 1) {
    teardown();
    teardown = subscribeCampDeskRealtime(`camp-${i}`, fake.factory, {
      onRefresh() {},
      onStatus() {},
    });
  }
  assert.equal(fake.openCount(), 1);
  teardown();
  assert.equal(fake.openCount(), 0);
  assert.equal(fake.channels.length, 10);
  assert.ok(fake.channels.every((c, idx) => c.closed || idx === 9));
  // After final teardown all closed
  assert.ok(fake.channels.every((c) => c.closed));
});

test("disconnect falls back to reconnecting status", () => {
  const fake = createFakeFactory();
  /** @type {string[]} */
  const statuses = [];
  subscribeCampDeskRealtime("camp-1", fake.factory, {
    onRefresh() {},
    onStatus(s) {
      statuses.push(s);
    },
  });
  fake.emitStatus(0, "SUBSCRIBED");
  fake.emitStatus(0, "CHANNEL_ERROR");
  fake.emitStatus(0, "TIMED_OUT");
  fake.emitStatus(0, "CLOSED");
  assert.deepEqual(statuses, [
    "live",
    "reconnecting",
    "reconnecting",
    "reconnecting",
  ]);
});

test("reconnect refetches once before live, hides reconnecting", () => {
  const fake = createFakeFactory();
  let refreshes = 0;
  /** @type {string[]} */
  const statuses = [];
  subscribeCampDeskRealtime("camp-1", fake.factory, {
    onRefresh() {
      refreshes += 1;
    },
    onStatus(s) {
      statuses.push(s);
    },
  });
  // First subscribe — no catch-up refresh (RSC snapshot is fresh)
  fake.emitStatus(0, "SUBSCRIBED");
  assert.equal(refreshes, 0);
  assert.deepEqual(statuses, ["live"]);

  fake.emitStatus(0, "CHANNEL_ERROR");
  assert.deepEqual(statuses, ["live", "reconnecting"]);

  // Reconnect — one catch-up then live
  fake.emitStatus(0, "SUBSCRIBED");
  assert.equal(refreshes, 1);
  assert.deepEqual(statuses, ["live", "reconnecting", "live"]);
});

test("empty campId is a no-op teardown", () => {
  const fake = createFakeFactory();
  const teardown = subscribeCampDeskRealtime("", fake.factory, {
    onRefresh() {
      assert.fail("should not refresh");
    },
    onStatus() {
      assert.fail("should not status");
    },
  });
  assert.equal(fake.channels.length, 0);
  teardown();
});

test("events after teardown are ignored", () => {
  const fake = createFakeFactory();
  let refreshes = 0;
  const teardown = subscribeCampDeskRealtime("camp-1", fake.factory, {
    onRefresh() {
      refreshes += 1;
    },
    onStatus() {},
  });
  teardown();
  fake.emitChange(0);
  fake.emitStatus(0, "SUBSCRIBED");
  assert.equal(refreshes, 0);
});
