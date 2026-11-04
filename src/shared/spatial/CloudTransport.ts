// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Per-window scan buffers: transmit only changes, retain only the active window. */
export class CloudTransport {
  private buffers = new Map<string, any>();
  clear() {
    this.buffers.clear();
  }
  apply(command: any, send: boolean): any {
    if (!Array.isArray(command?.objects)) return command;
    const active = new Set<string>();
    const objects = command.objects.map((object: any) => {
      if (object.type !== "cloud") return object;
      const id = object.id;
      active.add(id);
      const prior = this.buffers.get(id);
      if (send) {
        this.buffers.set(id, object);
        if (prior?.positions === object.positions && prior?.values === object.values && prior?.colors === object.colors)
          return { ...object, positions: undefined, values: undefined, colors: undefined };
        return object;
      }
      if (object.positions)
        this.buffers.set(id, { positions: object.positions, values: object.values, colors: object.colors });
      return { ...object, ...this.buffers.get(id) };
    });
    for (const id of this.buffers.keys()) if (!active.has(id)) this.buffers.delete(id);
    return { ...command, objects };
  }
}
