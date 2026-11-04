// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Per-window scan buffers: transmit only changes, retain only the active window. */
export class CloudTransport {
  missing = false;
  private static revision = 0;
  private buffers = new Map<string, any>();
  clear() {
    this.buffers.clear();
  }
  apply(command: any, send: boolean): any {
    this.missing = false;
    if (!Array.isArray(command?.objects)) return command;
    const active = new Set<string>();
    const objects = command.objects.map((object: any) => {
      if (object.type !== "cloud") return object;
      const id = object.id;
      active.add(id);
      const prior = this.buffers.get(id);
      if (send) {
        const unchanged =
          prior?.positions === object.positions && prior?.values === object.values && prior?.colors === object.colors;
        const revision = unchanged ? prior.cloudRevision : ++CloudTransport.revision;
        this.buffers.set(id, { ...object, cloudRevision: revision });
        if (unchanged)
          return { ...object, cloudRevision: revision, positions: undefined, values: undefined, colors: undefined };
        return { ...object, cloudRevision: revision };
      }
      if (object.positions)
        this.buffers.set(id, {
          positions: object.positions,
          values: object.values,
          colors: object.colors,
          cloudRevision: object.cloudRevision
        });
      if (!this.buffers.has(id) || this.buffers.get(id).cloudRevision !== object.cloudRevision) {
        this.missing = true;
        this.buffers.delete(id);
        return null;
      }
      return { ...object, ...this.buffers.get(id) };
    });
    for (const id of this.buffers.keys()) if (!active.has(id)) this.buffers.delete(id);
    return { ...command, objects: objects.filter((object: any) => object !== null) };
  }
}
