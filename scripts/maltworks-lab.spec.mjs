import assert from "node:assert/strict";
import test from "node:test";
import { generateLabFrames, labDeviceId, makeLabTelemetry } from "./maltworks-lab.mjs";

test("25 devices emit independent payloads with valid ESP32-like telemetry shape", () => {
  const frames = [...generateLabFrames({ devices: 25, frames: 12 })];
  assert.equal(frames.length, 300);
  assert.equal(new Set(frames.map((item) => item.deviceId)).size, 25);
  assert.equal(frames[0].deviceId, labDeviceId(0));
  assert.equal(frames[0].schemaVersion, 1);
  assert.equal(frames[0].bootId.length, 8);
  assert.equal(frames[0].firmware.product, "MaltworksController");
  assert.equal(frames[0].temperatures.refrigerator.connected, true);
  assert.equal(frames[0].alarms.active, false);
  assert.equal(frames.at(-1).sequence, 12);
});

test("reboot resets sequence and changes boot ID but keeps increasing sentAt", () => {
  const frames = [...generateLabFrames({ scenario: "reboot", frames: 10 })];
  assert.notEqual(frames[5].bootId, frames[6].bootId);
  assert.equal(frames[5].sequence, 6);
  assert.equal(frames[6].sequence, 1);
  assert.ok(frames[6].sentAt > frames[5].sentAt);
});

test("alarm and sensor loss have both activation and recovery transitions", () => {
  const alarm = [...generateLabFrames({ scenario: "alarm", frames: 12 })];
  assert.deepEqual(alarm.map((row) => row.alarms.active).slice(3, 9),
    [false, true, true, true, true, false]);
  const sensor = [...generateLabFrames({ scenario: "sensor-loss", frames: 12 })];
  assert.equal(sensor[4].temperatures.refrigerator.value, null);
  assert.equal(sensor[8].temperatures.refrigerator.connected, true);
});

test("offline simulates missing requests rather than inventing fake sensor readings", () => {
  const frames = [...generateLabFrames({ devices: 2, frames: 12, scenario: "offline" })];
  assert.equal(frames.length, 18);
  assert.equal(frames.filter((item) => item.deviceId === labDeviceId(0)).length, 6);
  assert.equal(frames.filter((item) => item.deviceId === labDeviceId(1)).length, 12);
});

test("command acknowledgement is emitted once; invalid input is refused", () => {
  const frames = [...generateLabFrames({ scenario: "command", frames: 12 })];
  assert.equal(frames.filter((item) => item.commandResult).length, 1);
  assert.equal(frames[6].commandResult.status, "applied");
  assert.throws(() => [...generateLabFrames({ devices: 26 })]);
  assert.throws(() => makeLabTelemetry(0, 0, { scenario: "unknown" }));
});
