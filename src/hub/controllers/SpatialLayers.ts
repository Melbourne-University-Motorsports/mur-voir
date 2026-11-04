// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { AnnotatedPose3d } from "../../shared/geometry";
import HistoryCursor from "../../shared/log/HistoryCursor";
import Log from "../../shared/log/Log";
import { Field3dRendererCommand_AnyObj } from "../../shared/renderers/Field3dRenderer";
import { CloudCache, cloudRange, cloudWindow, rosStamp } from "../../shared/spatial/CloudWindow";
import { coneStyle } from "../../shared/spatial/ConeStyle";
import { metadata, rosPose, spatialSnapshot } from "../../shared/spatial/SpatialLog";
import { TFTree, normalizeFrameId } from "../../shared/spatial/TFTree";
import { Transform, compose, identity } from "../../shared/spatial/Transform";
import { URDFRobot, computeLinkPoses } from "../../shared/spatial/URDF";
import { CloudDecoder } from "../CloudDecoder";

export class SpatialLayers {
  tree = new TFTree();
  private scanTree = new TFTree();
  private stampOffsets = new Map<string, number>();
  private badStamps = 0;
  private candidates = new Map<string, Map<number, string>>();
  cloudWarn = false;
  private partialSince = new Map<string, number>();
  private lastErrors = new Map<string, { signature: string; error: string }>();
  private workerRetries = new Map<string, number>();
  robot: URDFRobot | null = null;
  assets: Record<string, string> = {};
  private log: Log | null = null;
  private time = -Infinity;
  private processed = new Map<string, number>();
  private markers = new Map<string, { cursor: HistoryCursor; active: Map<string, { marker: any; stamp: number }> }>();
  private trails = new Map<string, { cursor: HistoryCursor; samples: { stamp: number; value: any }[] }>();
  private static clouds = new WeakMap<Log, CloudCache>();
  private cloudOwners = new Map<string, object>();
  cloudStatus = "";
  cloudFields = new Map<string, string[]>();
  private presentations = new Map<
    string,
    {
      signature: string;
      wanted: string;
      objects: Field3dRendererCommand_AnyObj[];
      range: { min: number; max: number };
      time: number;
      stamp: number;
    }
  >();
  private decodeWindows = new Map<string, { signature: string; wanted: string[]; superseded: number }>();
  private continuous = false;
  private activeCloudLayers = new Set<string>();
  private admissionErrors = new Set<string>();

  private pending = new Set<string>();
  private generation = 0;
  joints: Record<string, number> = {};
  begin(log: Log, time: number, continuous = false) {
    this.continuous = continuous;
    if (!continuous) {
      this.lastErrors.clear();
      this.partialSince.clear();
    }
    for (const id of this.cloudOwners.keys())
      if (!this.activeCloudLayers.has(id)) {
        this.presentations.delete(id);
        this.cloudOwners.delete(id);
        this.decodeWindows.delete(id);
        this.candidates.delete(id);
        this.partialSince.delete(id);
        this.lastErrors.delete(id);
      }
    this.activeCloudLayers.clear();
    if (log !== this.log || time < this.time) {
      this.markers.clear();
      this.trails.clear();
      this.generation++;
      this.cloudOwners.clear();
      this.presentations.clear();
      this.decodeWindows.clear();
      this.admissionErrors.clear();
      this.cloudFields.clear();
      if (this.log && log !== this.log) SpatialLayers.clouds.delete(this.log);
      this.pending.clear();
      this.tree.clear();
      this.scanTree.clear();
      this.stampOffsets.clear();
      this.badStamps = 0;
      this.candidates.clear();
      this.partialSince.clear();
      this.lastErrors.clear();
      this.workerRetries.clear();
      this.processed.clear();
      this.joints = {};
    }
    this.log = log;
    this.time = time;
    for (const key of log.getFieldKeys()) {
      const type = log.getStructuredType(key);
      if (type === "tf2_msgs/TFMessage") {
        const data = log.getString(key + "/spatial", this.processed.get(key) ?? -Infinity, time);
        if (!data) continue;
        data.timestamps.forEach((stamp, i) => {
          if (stamp > time || stamp <= (this.processed.get(key) ?? -Infinity)) return;
          const msg = JSON.parse(data.values[i]);
          for (const tf of msg.transforms ?? []) {
            this.tree.addTransform(
              tf.header.frame_id,
              tf.child_frame_id,
              stamp,
              rosPose(tf.transform),
              key.endsWith("tf_static")
            );
            const source = key + ":" + tf.child_frame_id;
            const acquisition = rosStamp(tf.header?.stamp, stamp);
            const offset = stamp - acquisition;
            const established = this.stampOffsets.get(source);
            if (established !== undefined && Math.abs(offset - established) > 2) {
              this.badStamps++;
            } else {
              this.stampOffsets.set(source, established ?? offset);
              this.scanTree.addTransform(
                tf.header.frame_id,
                tf.child_frame_id,
                acquisition,
                rosPose(tf.transform),
                key.endsWith("tf_static")
              );
            }
          }
          this.processed.set(key, stamp);
        });
      } else if (type === "sensor_msgs/JointState") {
        const msg = spatialSnapshot(log, key, time)?.value;
        msg?.name?.forEach((name: string, i: number) => {
          if (Number.isFinite(msg.position[i])) this.joints[name] = msg.position[i];
        });
      }
    }
  }
  resolve(frame: string, fixed: string, time: number): Transform {
    if (!frame) throw new Error("missing frame");
    if (normalizeFrameId(frame) === normalizeFrameId(fixed)) return identity();
    const result = this.tree.lookup(fixed, frame, time);
    if (result.status !== "ok") throw new Error(result.status + ": " + frame + " → " + fixed);
    return result.transform;
  }
  private scanPose(frame: string, fixed: string, stamp: any, receipt: number, issues: string[]): Transform {
    if (normalizeFrameId(frame) === normalizeFrameId(fixed)) return identity();
    const acquisition = rosStamp(stamp, receipt);
    const chain = new Set<string>();
    for (const endpoint of [frame, fixed]) {
      let current: string | null = normalizeFrameId(endpoint);
      while (current && !chain.has(current)) {
        chain.add(current);
        current = this.scanTree.getParent(current);
      }
    }
    const dynamic = new Set(
      this.scanTree
        .getEdges(acquisition)
        .filter((e) => !e.isStatic && chain.has(e.child))
        .map((e) => e.child)
    );
    const offsets = [...this.stampOffsets.entries()]
      .filter(([key]) => dynamic.has(normalizeFrameId(key.slice(key.lastIndexOf(":") + 1))))
      .map(([, offset]) => offset);
    if (!this.scanTree.hasFrame(frame)) return this.resolve(frame, fixed, receipt);
    // Compare domains on dynamic edges, never static TF epochs or absolute epoch offsets.
    if (offsets.some((offset) => Math.abs(receipt - acquisition - offset) > 2)) {
      issues.push("cloud/TF clock mismatch; receipt-time pose");
      return this.resolve(frame, fixed, receipt);
    }
    const result = this.scanTree.lookup(fixed, frame, acquisition);
    if (result.status !== "ok") throw new Error(result.status + ": " + frame + " → " + fixed);
    return result.transform;
  }
  frameFor(log: Log, key: string, time: number): string {
    return spatialSnapshot(log, key, time)?.value?.header?.frame_id ?? metadata(log, key).frame_id ?? "";
  }
  objects(
    log: Log,
    key: string,
    time: number,
    fixed: string,
    options: Record<string, string> = {},
    layerId = key
  ): { objects: Field3dRendererCommand_AnyObj[]; frame: string; stamp: number } {
    if (log.getStructuredType(key) === "sensor_msgs/PointCloud2")
      return this.cloud(log, key, time, fixed, options, layerId);
    const snapshot = spatialSnapshot(log, key, time);
    const type = log.getStructuredType(key);
    if (!snapshot && !(type === "visualization_msgs/MarkerArray" && this.markers.has(key))) {
      throw new Error("waiting for spatial sample");
    }
    const msg = snapshot?.value ?? {};
    const murType = metadata(log, key).type;
    const frame =
      msg.header?.frame_id ??
      (["tf2_msgs/TFMessage", "visualization_msgs/MarkerArray"].includes(type ?? "") ? fixed : "");
    const transform = this.resolve(frame, fixed, time);
    const pose = (value: any, tf = transform): AnnotatedPose3d => ({
      pose: compose(tf, rosPose(value)),
      annotation: { is2DSource: false }
    });
    let objects: Field3dRendererCommand_AnyObj[] = [];
    if (murType === "trajectory") {
      objects.push({ type: "trajectory", color: "#eeeeee", size: "normal", poses: msg.poses.map((p: any) => pose(p)) });
    } else if (murType === "cone_array") {
      for (const cone of msg.cones) {
        const style = coneStyle(cone);
        const large = style?.large ?? false;
        objects.push({
          type: "marker",
          frameTransform: transform,
          marker: {
            type: 3,
            shape: "cone",
            pose: compose(transform, {
              translation: [cone.position.x, cone.position.y, cone.position.z + (large ? 0.25 : 0.16)],
              rotation: [1, 0, 0, 0]
            }),
            scale: { x: large ? 0.4 : 0.25, y: large ? 0.4 : 0.25, z: large ? 0.5 : 0.32 },
            color: style?.color ?? { r: 0.5, g: 0.5, b: 0.5, a: 1 }
          }
        });
      }
    } else if (murType === "pose3") {
      objects.push(...this.vehicle(log, key, time, fixed, pose(msg).pose));
    } else if (type === "nav_msgs/Path")
      objects.push({
        type: "trajectory",
        color: "#eeeeee",
        size: "normal",
        poses: (msg.poses ?? []).map((p: any) => pose(p.pose, this.resolve(p.header?.frame_id || frame, fixed, time)))
      });
    else if (type === "tf2_msgs/TFMessage") {
      objects.push({
        type: "axes",
        poses: this.tree
          .getFrames()
          .map((name) => ({ pose: this.resolve(name, fixed, time), annotation: { is2DSource: false } }))
      });
      if (this.robot && this.tree.hasFrame(this.robot.rootLink)) {
        objects.push(...this.vehicle(log, key, time, fixed, this.resolve(this.robot.rootLink, fixed, time)));
      }
    } else if (type === "visualization_msgs/MarkerArray") {
      let cache = this.markers.get(key);
      if (!cache) this.markers.set(key, (cache = { cursor: new HistoryCursor(), active: new Map() }));
      const { cursor, active } = cache;
      const start = cursor.update(log, key + "/spatial", time, () => active.clear());
      const history = log.getString(key + "/spatial", start, time);
      history?.timestamps.forEach((stamp, i) => {
        if (stamp > time || stamp <= start || (i === 0 && stamp === cursor.heldTimestamp)) return;
        for (const marker of JSON.parse(history.values[i]).markers ?? []) {
          const id = (marker.ns ?? "") + ":" + marker.id;
          if (marker.action === 3) active.clear();
          else if (marker.action === 2) active.delete(id);
          else active.set(id, { marker, stamp });
        }
        cursor.stamp = stamp;
      });
      for (const { marker, stamp } of active.values()) {
        const lifetime = Number(marker.lifetime?.sec ?? 0) + Number(marker.lifetime?.nanosec ?? 0) * 1e-9;
        if (lifetime > 0 && time > stamp + lifetime) continue;
        const tf = this.resolve(marker.header?.frame_id, fixed, time);
        const style = coneStyle(marker);
        objects.push({
          type: "marker",
          marker: {
            ...marker,
            ...(style ? { shape: "cone", color: style.color } : {}),
            pose: pose(marker.pose, tf).pose
          },
          frameTransform: tf
        });
      }
    } else if (type === "geometry_msgs/PoseStamped" || type === "nav_msgs/Odometry") {
      const p = type === "nav_msgs/Odometry" ? msg.pose.pose : msg.pose;
      objects.push(...this.vehicle(log, key, time, fixed, pose(p).pose));
    }
    return { objects, frame, stamp: snapshot?.time ?? time };
  }
  private vehicle(
    log: Log,
    key: string,
    time: number,
    fixed: string,
    root: Transform
  ): Field3dRendererCommand_AnyObj[] {
    const objects: Field3dRendererCommand_AnyObj[] = [];
    if (this.robot)
      objects.push({
        type: "urdf",
        robot: this.robot,
        assets: this.assets,
        links: computeLinkPoses(this.robot, this.joints, root, (link) => {
          const result = this.tree.lookup(fixed, link, time);
          return result.status === "ok" ? result.transform : null;
        }).links
      });
    let trail = this.trails.get(key);
    if (!trail) this.trails.set(key, (trail = { cursor: new HistoryCursor(), samples: [] }));
    const start = trail.cursor.update(log, key + "/spatial", time, () => {
      trail!.samples = [];
    });
    const history = log.getString(key + "/spatial", Math.max(start, log.getTimestampRange()[0], time - 10), time);
    history?.timestamps.forEach((stamp, i) => {
      if (stamp > time || stamp <= start || (i === 0 && stamp === trail!.cursor.heldTimestamp)) return;
      trail!.samples.push({ stamp, value: JSON.parse(history.values[i]) });
      trail!.cursor.stamp = stamp;
    });
    const cutoff = Math.max(log.getTimestampRange()[0], time - 10);
    while (trail.samples.length > 1 && trail.samples[1].stamp <= cutoff) trail.samples.shift();
    const poses: AnnotatedPose3d[] = [];
    trail.samples.forEach(({ stamp, value: msg }) => {
      const p = msg.pose?.pose ?? msg.pose ?? msg;
      try {
        poses.push({
          pose:
            log.getStructuredType(key) === "tf2_msgs/TFMessage" && this.robot
              ? this.resolve(this.robot.rootLink, fixed, stamp)
              : compose(this.resolve(msg.header?.frame_id, fixed, stamp), rosPose(p)),
          annotation: { is2DSource: false }
        });
      } catch {
        /* A trail never invents a missing transform. */
      }
    });
    objects.push({ type: "trajectory", color: "#aaa", size: "normal", poses });
    return objects;
  }
  private cloud(log: Log, key: string, time: number, fixed: string, options: Record<string, string>, layerId: string) {
    this.activeCloudLayers.add(layerId);
    const decay = Math.max(1, Math.min(20, Math.floor(Number(options.decay ?? 1)) || 1));
    const history = log.getField(key);
    const indexes = history ? cloudWindow(history, time, decay) : [];
    if (!indexes.length) throw new Error("waiting for cloud");
    const maxPoints = Math.max(1, Math.floor(Number(options.cloudBudget ?? 2_000_000) / decay));
    const field = options.field ?? "";
    const cacheKey = (t: number) => JSON.stringify([key, t, field, maxPoints]);
    let cache = SpatialLayers.clouds.get(log);
    if (!cache) {
      cache = new CloudCache();
      SpatialLayers.clouds.set(log, cache);
    }
    let owner = this.cloudOwners.get(layerId);
    if (!owner) {
      owner = {};
      this.cloudOwners.set(layerId, owner);
    }
    log.setCloudDecay(key, decay, owner);
    const wanted = indexes.map(cacheKey);
    let candidates = this.candidates.get(layerId);
    if (
      !this.continuous ||
      !candidates ||
      this.decodeWindows.get(layerId)?.signature !== JSON.stringify([key, fixed, options])
    ) {
      candidates = new Map();
      this.candidates.set(layerId, candidates);
    }
    indexes.forEach((t) => candidates!.set(t, cacheKey(t)));
    while (candidates.size > 120) candidates.delete(candidates.keys().next().value!);
    for (const id of this.admissionErrors)
      if (!this.pending.has(id) && !wanted.includes(id)) this.admissionErrors.delete(id);
    const signature = JSON.stringify([key, fixed, options]);
    const priorWindow = this.decodeWindows.get(layerId);
    let superseded = 0;
    if (this.continuous && priorWindow?.signature === signature) {
      superseded =
        priorWindow.superseded + priorWindow.wanted.filter((id) => !wanted.includes(id) && !cache!.get(id)).length;
    }
    this.decodeWindows.set(layerId, { signature, wanted, superseded });
    let previous = this.presentations.get(layerId);
    if (previous?.signature !== signature || time < previous.time) previous = undefined;
    cache.protect(owner, [...wanted, ...(this.continuous ? previous?.objects.map((o: any) => o.id) ?? [] : [])]);
    const objects: Field3dRendererCommand_AnyObj[] = [];
    const issues: string[] = [];
    let invalidScalars = 0;
    let frame = "",
      stamp = 0,
      ready = 0,
      decimated = false;
    // Newest first; if the bounded worker pool is busy we retry from current history next frame.
    for (const t of [...indexes].reverse()) {
      const id = cacheKey(t),
        result = cache.get(id);
      if (!result && !this.pending.has(id)) {
        const meta = metadata(log, key);
        const bytes = log.getRaw(key, t, t)?.values[0];
        const request =
          bytes &&
          CloudDecoder.request(
            { encoding: meta.encoding, definition: meta.definition, bytes, field, maxPoints },
            owner
          );
        if (request) {
          this.pending.add(id);
          const generation = this.generation;
          request
            .then((result) => {
              if (generation !== this.generation) return;
              this.pending.delete(id);
              if (!cache!.set(id, result)) this.admissionErrors.add(id);
              else this.admissionErrors.delete(id);
            })
            .catch(() => {
              if (generation !== this.generation) return;
              this.pending.delete(id);
              const tries = (this.workerRetries.get(id) ?? 0) + 1;
              this.workerRetries.set(id, tries);
              if (tries >= 3) cache!.set(id, { error: "cloud worker failed after 3 attempts" });
            });
        }
      }
      if (!result) {
        if (this.admissionErrors.has(id)) issues.push("cloud cache budget exceeded; retrying");
        continue;
      }
      ready++;
      if (result.fields) this.cloudFields.set(key, result.fields);
      if (result.error) {
        issues.push(result.error);
        continue;
      }
      if (result.fallbackField) issues.push("colour by z (no field chosen)");
      invalidScalars += result.invalidScalars ?? 0;
      if (!result.positions.length) issues.push("no drawable points");
      frame = result.frame;
      stamp = Math.max(stamp, t);
      decimated ||= result.stride > 1;

      try {
        objects.push({
          type: "cloud",
          ...result,
          id,
          transform: this.scanPose(frame, fixed, result.stamp, t, issues),
          receiptTime: t,
          size: Number(options.size ?? 3),
          map: options.map ?? "viridis"
        });
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
      }
    }
    const complete = ready === indexes.length;
    const wantedKey = JSON.stringify(wanted);
    let range =
      !complete && previous && (this.continuous || previous.wanted === wantedKey)
        ? previous.range
        : cloudRange(objects as { min: number; max: number }[]);
    for (const object of objects) Object.assign(object, range);
    const held = this.continuous && !objects.length && !complete && !issues.length;
    if (held) {
      // Only scans requested in this continuous segment are eligible. A seek clears candidates.
      const newest = [...candidates]
        .filter(([t, id]) => t <= time && cache!.get(id) && !cache!.get(id).error)
        .sort((a, b) => b[0] - a[0])[0];
      if (newest) {
        const [t, id] = newest,
          result = cache.get(id);
        try {
          objects.push({
            type: "cloud",
            ...result,
            ...range,
            id,
            receiptTime: t,
            transform: this.scanPose(result.frame, fixed, result.stamp, t, issues),
            size: Number(options.size ?? 3),
            map: options.map ?? "viridis"
          });
          stamp = t;
          frame = result.frame;
          invalidScalars = result.invalidScalars ?? 0;
          decimated = result.stride > 1;
        } catch (error) {
          issues.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (invalidScalars) issues.push(invalidScalars + " invalid " + field + " (magenta)");
    const lag = objects.length ? time - stamp : 0;
    if (complete) this.partialSince.delete(layerId);
    else if (!this.partialSince.has(layerId)) this.partialSince.set(layerId, Date.now());
    const sustained = Date.now() - (this.partialSince.get(layerId) ?? Date.now()) >= 500;
    const shortage = indexes.length < decay;
    this.cloudWarn = issues.length > 0 || shortage || this.badStamps > 0 || (held && sustained);
    this.cloudStatus = [
      ...new Set(issues),
      held && sustained ? "holding · " + lag.toFixed(2) + " s behind" : "",
      superseded ? superseded + " scans superseded" : "",
      ready < indexes.length && (!objects.length || sustained) ? "partial " + ready + "/" + indexes.length : "",
      shortage
        ? "scans " +
          indexes.length +
          "/" +
          decay +
          (log.hasCloudRetentionShortage(key) ? " (retention / 256 MiB total limit)" : " (log start)")
        : "",
      this.badStamps ? this.badStamps + " TF stamp outliers rejected" : "",
      decimated ? "decimating · " + (maxPoints * decay).toLocaleString("en-US") + " point layer budget" : ""
    ]
      .filter(Boolean)
      .join(" · ");
    if (!objects.length) {
      if (issues.length) this.lastErrors.set(layerId, { signature, error: this.cloudStatus });
      const lastError = this.lastErrors.get(layerId);
      if (lastError?.signature === signature && !complete) throw new Error(lastError.error);
      this.presentations.delete(layerId);
      throw new Error(issues.length ? this.cloudStatus : "decoding cloud… " + this.cloudStatus);
    }
    this.lastErrors.delete(layerId);
    this.presentations.set(layerId, { signature, wanted: wantedKey, objects: [...objects], range, time, stamp });
    return { objects: objects.reverse(), frame, stamp };
  }
}
