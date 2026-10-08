/**
 * Wake-on-LAN: a magic packet (6 × 0xFF + 16 × MAC) to the broadcast address
 * of the PC's network and to 255.255.255.255, UDP ports 9 and 7.
 */
"use strict";

const dgram = require("dgram");

const magicPacket = (mac) => {
  const bytes = Buffer.from(String(mac).replace(/[:-]/g, ""), "hex");

  if (bytes.length !== 6) throw new Error("bad mac");

  const packet = Buffer.alloc(102, 0xff);

  for (let i = 0; i < 16; i++) bytes.copy(packet, 6 + i * 6);

  return packet;
};

/** @returns {Promise<void>} rejects on a socket error */
const wake = (mac, broadcast, { ports = [9, 7] } = {}) =>
  new Promise((resolve, reject) => {
    let packet;

    try {
      packet = magicPacket(mac);
    } catch (error) {
      reject(error);
      return;
    }

    const socket = dgram.createSocket("udp4");
    const targets = [...new Set([broadcast, "255.255.255.255"].filter(Boolean))];
    let left = targets.length * ports.length;
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {
        // already closed
      }
      if (error) reject(error);
      else resolve();
    };

    socket.on("error", finish);
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (error) {
        finish(error);
        return;
      }
      for (const address of targets) {
        for (const port of ports) {
          socket.send(packet, port, address, (error) => {
            if (error) finish(error);
            else if (--left === 0) finish();
          });
        }
      }
    });
  });

module.exports = { wake, magicPacket };
