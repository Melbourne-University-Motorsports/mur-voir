// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Two reusable workers shared across 3D tabs. No unbounded waiting queue. */
export class CloudDecoder {
  private static slots: { worker: Worker; busy: boolean }[] = [];
  private static waiters = new Map<object, number>();
  static request(payload: any, owner?: object): Promise<any> | null {
    for (const [key, time] of this.waiters) if (Date.now() - time > 100) this.waiters.delete(key);
    if (owner && this.waiters.size && this.waiters.keys().next().value !== owner) {
      this.waiters.set(owner, Date.now());
      return null;
    }
    let slot = this.slots.find((s) => !s.busy);
    if (!slot && this.slots.length < 2) {
      slot = { worker: new Worker("../bundles/pointCloudWorker.js", { type: "module" }), busy: false };
      this.slots.push(slot);
    }
    if (!slot) {
      if (owner) this.waiters.set(owner, Date.now());
      return null;
    }
    if (owner) this.waiters.delete(owner);
    const target = slot;
    target.busy = true;
    return new Promise((resolve, reject) => {
      const fail = (error: unknown) => {
        clearTimeout(timeout);
        target.worker.terminate();
        this.slots = this.slots.filter((s) => s !== target);
        reject(error);
      };
      const timeout = setTimeout(() => fail(new Error("cloud decode timed out")), 10000);
      target.worker.onmessage = (event) => {
        clearTimeout(timeout);
        target.busy = false;
        resolve(event.data.payload);
      };
      target.worker.onerror = fail;
      // Copy exactly one message, then transfer the copy. Log's backing storage stays attached.
      const bytes = payload.bytes.slice();
      target.worker.postMessage({ id: 0, payload: { ...payload, bytes } }, [bytes.buffer]);
    });
  }
}
