import type { RoomModule } from '../packages/room-runtime/types';
export const ROOMS: RoomModule[] = [
  {id:'office-v4', label:'Wes’s office', build:async () => (await import('./office-v4')).officeV4.build()},
  {id:'bengkel', label:'Bengkel · workshop', build:async () => (await import('./bengkel')).bengkel.build()},
  {id:'f1', label:'F1 · office floor', build:async () => (await import('./f1')).f1.build()},
];
export const roomById = (id:string|null) => ROOMS.find(r=>r.id===id) ?? ROOMS[0];
export type {BuiltRoom, RoomModule} from '../packages/room-runtime/types';
