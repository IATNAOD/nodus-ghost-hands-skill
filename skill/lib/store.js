/**
 * Persistence of keys, PCs and history. One API over the skill models
 * (ctx.models on the device) and over Maps (tests, tools/dev-host.js).
 * Records are plain objects; ids of users are strings.
 */
"use strict";

const clone = (value) => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)));

/** @param {{ Keys: object, Devices: object, History?: object }} models mongoose models from ctx.models */
const createStore = (models) => {
  const { Keys, Devices, History } = models;

  return {
    keys: {
      byUser: (userId) => Keys.findOne({ userId: String(userId) }).lean(),
      byHash: (keyHash) => (keyHash ? Keys.findOne({ keyHash }).lean() : Promise.resolve(null)),
      secretOf: async (userId) => (await Keys.findOne({ userId: String(userId) }).select("+keyEnc").lean())?.keyEnc ?? null,
      put: (userId, { userName, keyHash, keyEnc }) =>
        Keys.updateOne(
          { userId: String(userId) },
          { $set: { userName: userName ?? "", keyHash, keyEnc, createdAt: new Date(), lastUsedAt: null } },
          { upsert: true },
        ),
      touch: (userId) => Keys.updateOne({ userId: String(userId) }, { $set: { lastUsedAt: new Date() } }),
    },

    devices: {
      all: () => Devices.find({}).lean(),
      byId: (deviceId) => Devices.findOne({ deviceId }).lean(),
      byUser: (userId) => Devices.find({ userId: String(userId) }).lean(),
      byMachine: (userId, machineHash) => (machineHash ? Devices.findOne({ userId: String(userId), machineHash }).lean() : Promise.resolve(null)),
      create: async (record) => (await Devices.create(record)).toObject(),
      update: (deviceId, fields) => Devices.updateOne({ deviceId }, { $set: fields }),
      /** Only a newer revision replaces the config. @returns {Promise<boolean>} */
      saveConfig: async (deviceId, rev, config) => {
        const { modifiedCount, matchedCount } = await Devices.updateOne(
          { deviceId, configRev: { $lt: rev } },
          { $set: { config, configRev: rev, name: config.name } },
        );

        return Boolean(modifiedCount || matchedCount);
      },
      remove: (deviceId) => Devices.deleteOne({ deviceId }),
    },

    history: {
      add: (entry) => (History ? History.create(entry).then(() => undefined) : Promise.resolve()),
      recent: (userId, limit = 30) => (History ? History.find({ userId: String(userId) }).sort({ at: -1 }).limit(limit).lean() : Promise.resolve([])),
    },
  };
};

/** The same API in memory. */
const createMemoryStore = () => {
  const keys = new Map();
  const devices = new Map();
  const history = [];

  return {
    _data: { keys, devices, history },

    keys: {
      byUser: async (userId) => clone(withoutSecret(keys.get(String(userId)))) ?? null,
      byHash: async (keyHash) => clone(withoutSecret([...keys.values()].find((key) => key.keyHash === keyHash))) ?? null,
      secretOf: async (userId) => keys.get(String(userId))?.keyEnc ?? null,
      put: async (userId, { userName, keyHash, keyEnc }) => {
        keys.set(String(userId), { userId: String(userId), userName: userName ?? "", keyHash, keyEnc, createdAt: new Date(), lastUsedAt: null });
      },
      touch: async (userId) => {
        const key = keys.get(String(userId));

        if (key) key.lastUsedAt = new Date();
      },
    },

    devices: {
      all: async () => [...devices.values()].map(clone),
      byId: async (deviceId) => clone(devices.get(deviceId)) ?? null,
      byUser: async (userId) => [...devices.values()].filter((device) => device.userId === String(userId)).map(clone),
      byMachine: async (userId, machineHash) =>
        machineHash ? clone([...devices.values()].find((device) => device.userId === String(userId) && device.machineHash === machineHash)) ?? null : null,
      create: async (record) => {
        const full = { userName: "", name: "", machineHash: "", config: null, configRev: 0, lastSeenAt: null, lastIp: "", createdAt: new Date(), ...record };

        devices.set(record.deviceId, clone(full));
        return clone(full);
      },
      update: async (deviceId, fields) => {
        const device = devices.get(deviceId);

        if (device) Object.assign(device, clone(fields));
      },
      saveConfig: async (deviceId, rev, config) => {
        const device = devices.get(deviceId);

        if (!device || device.configRev >= rev) return false;
        Object.assign(device, { config: clone(config), configRev: rev, name: config.name });
        return true;
      },
      remove: async (deviceId) => {
        devices.delete(deviceId);
      },
    },

    history: {
      add: async (entry) => {
        history.unshift({ at: new Date(), ...entry });
        history.length = Math.min(history.length, 500);
      },
      recent: async (userId, limit = 30) => history.filter((entry) => entry.userId === String(userId)).slice(0, limit).map(clone),
    },
  };
};

function withoutSecret(record) {
  if (!record) return record;

  const { keyEnc, ...rest } = record;

  return rest;
}

module.exports = { createStore, createMemoryStore };
