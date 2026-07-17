import * as THREE from 'three';

/**
 * Minimal placeholder for the C2 simulation. Real ECS (units, selection, order queue, A* pathfinding
 * on the baked cost grid, fog of war, LOS) lands in milestones 3+. Kept as a seam so main.ts already
 * has an update hook wired into the frame loop.
 */
export class SimWorld {
  readonly units: THREE.Object3D[] = [];

  constructor(private group: THREE.Group) {
    void this.group;
  }

  update(_dt: number): void {
    // order processing / unit movement goes here
  }
}
