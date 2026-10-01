import type { SourceDescriptor, SourceChunk, SourceEnd, SourceBeginAck, SourceChunkAck, SourceFinishAck, SourceStatus } from './source-protocol.js';
export type FolderResult =
  | { status: 'ready'; label: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export type RecordingResult = { ok: true; id?: string; name?: string; bytes?: number; warning?: string } | { ok: false; message: string };
export type RecoveryImportResult = { ok: true; episodeId: string; participantId: string; epochs: number; bytes: number;
  complete: boolean; unchanged: boolean } | { ok: false; message: string; cancelled?: boolean };

export type ReadinessStage = 'pending' | 'passed' | 'failed' | 'not-proven';
export type GuestReadiness = {
  routeType: 'direct' | 'tunnel';
  stages: { listener: ReadinessStage; address: ReadinessStage; https: ReadinessStage; route: ReadinessStage; outside: ReadinessStage };
  check: { url: string; expiresAt: number } | null;
  hint: { code: 'HOST_DNS_LOOKUP_FAILED' | 'HOST_TLS_VALIDATION_FAILED' | 'HOST_ROUTE_MISMATCH' | 'HOST_ROUTE_UNREACHABLE'; message: string } | null;
  diagnosis: { code: 'LOCAL_PORT_BUSY' | 'OUTSIDE_CHECK_EXPIRED' | 'DIRECT_OUTSIDE_UNREACHABLE' | 'PROVIDER_OUTSIDE_UNREACHABLE'; message: string } | null;
};
type GuestSuccessBase = {
  ok: true;
  origin: string; 
  connectionMessage?: string;
  port: number | null;
  helper: { provider: 'cloudflare' | 'localhost-run'; iceTransportPolicy: RTCIceTransportPolicy; quota: 'unknown' } | null;
  invite: { url: string; expiresAt: number } | null; 
  guests: any[];
};
export type HelperInput = { provider: 'cloudflare' | 'localhost-run'; freeAccountConfirmed: true; relay: { urls: string[]; username: string; credential: string; iceTransportPolicy: RTCIceTransportPolicy } };
export type CallConfiguration = { ok: true; iceServers: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy } | { ok: false; message: string };
export type GuestStatus = (GuestSuccessBase & (
  | { phase: 'off'; readiness: null }
  | { phase: 'checking' | 'outside-check' | 'ready' | 'blocked'; readiness: GuestReadiness }
)) | { ok: false; message: string };

export type DirectPlan = {
  generation: number;
  gateway: string;
  localAddress: string;
  transport: 'TCP';
  protocol: 'PCP';
  publicPort: number;
  localProxyPort: number;
  guestTarget: string;
  requestedLifetimeSeconds: 1800;
};
type DirectLease = { externalAddress: string; externalPort: number; expiresAt: number };
export type DirectAccessStatus =
  | { ok: true; phase: 'idle'; plan: null; lease: null; message: string }
  | { ok: true; phase: 'planned'; plan: DirectPlan; lease: null; message: string }
  | { ok: true; phase: 'active'; plan: DirectPlan; lease: DirectLease; message: string }
  | { ok: false; phase: 'blocked' | 'cleanup-pending'; plan: DirectPlan | null; lease: DirectLease | null; message: string };

export type GuestSettingsInput = {domain:'yes'|'no';origin:string;port:number;helper:HelperInput};
export type GuestSettingsResult = {ok:true;settings:(GuestSettingsInput & {credentialSaved:true})|null}|{ok:false;message:string};
export type LicenseStatus = {active:true;license:{licenseId:string;holder:string;kind:'owner'|'test'|'customer';issuedAt:string};message?:string}|{active:false;message?:string};
export interface DesktopBridge {
  loadGuestSettings():Promise<GuestSettingsResult>;
  saveGuestSettings(input:GuestSettingsInput):Promise<GuestSettingsResult>;
  clearGuestSettings():Promise<GuestSettingsResult>;
  generateSavedGuestInvite():Promise<GuestStatus>;
  startFreeGuestAccess(input:{port:number;helper:HelperInput}):Promise<GuestStatus>;
  appInfo():Promise<{version:string;updates:string}>;
  licenseStatus():Promise<LicenseStatus>;
  activateLicense(key:string):Promise<LicenseStatus>;
  deactivateLicense():Promise<LicenseStatus>;
  openUpdates():Promise<{ok:boolean;message?:string}>;
  openGuestProvider(provider:'cloudflare'|'expressturn'):Promise<{ok:boolean;message?:string}>;
  getSceneBackdrops():Promise<{ok:boolean;backdrops?:Record<string,string>;message?:string}>;
  chooseSceneBackdrop(id:string):Promise<{ok:boolean;backdrops?:Record<string,string>;message?:string;cancelled?:boolean}>;
  resetSceneBackdrop(id:string):Promise<{ok:boolean;backdrops?:Record<string,string>;message?:string}>;
  listRecordings(): Promise<{ok:true;recordings:{id:string;name:string;label:string;createdAt:number;durationMs:number}[]}|{ok:false;message:string}>;
  renameRecording(id:string,label:string):Promise<{ok:boolean;message?:string}>;
  openLibraryRecording(id:string):Promise<{ok:boolean;message?:string}>;
  loadDevicePreferences():Promise<{ok:boolean;preferences?:{camera:string;microphone:string;height:1080|2160};message?:string}>;
  saveDevicePreferences(value:{camera:string;microphone:string;height:1080|2160}):Promise<{ok:boolean;message?:string}>;
  configureGuests(config: { origin: string; port: number; routeType: 'direct' | 'tunnel'; helper?: HelperInput }): Promise<GuestStatus>;
  guestStatus(): Promise<GuestStatus>;
  getGuestCallConfiguration(sessionId: string): Promise<CallConfiguration>;
  copyGuestReadiness(): Promise<{ ok: boolean; message?: string }>;
  failGuestReadiness(): Promise<GuestStatus>;
  directAccessStatus(): Promise<DirectAccessStatus>;
  prepareGuestDirectAccess(): Promise<DirectAccessStatus>;
  approveGuestDirectAccess(): Promise<DirectAccessStatus>;
  createGuestInvite(): Promise<GuestStatus>;
  copyGuestInvite(): Promise<{ ok: boolean; message?: string }>;
  revokeGuestInvites(): Promise<GuestStatus>;
  stopGuests(): Promise<GuestStatus>;
  guestAdmit(id: string): Promise<{ ok: boolean; message?: string }>;
  guestReject(id: string): Promise<{ ok: boolean; message?: string }>;
  guestRemove(id: string): Promise<{ ok: boolean; message?: string }>;
  revokeGuestInvite(token: string): Promise<{ ok: boolean; message?: string }>;
  sendGuestSignal(sessionId: string, callId: string, message: any): Promise<{ ok: boolean; message?: string }>;
  pollGuestSignals(sessionId: string, callId: string, after: number): Promise<{ ok: boolean; message?: string; messages?: { sequence: number; message: any }[]; latest?: number }>;
  sourceStatus(): Promise<SourceStatus | null>;
  beginHostSource(descriptor: SourceDescriptor): Promise<SourceBeginAck>;
  appendHostSource(chunk: SourceChunk, bytes: ArrayBuffer): Promise<SourceChunkAck>;
  finishHostSource(end: SourceEnd): Promise<SourceFinishAck>;
  closeSourceEpisode(): Promise<{ ok: boolean; message?: string }>;
  importGuestRecovery(): Promise<RecoveryImportResult>;
  beginRecording(): Promise<RecordingResult>;
  appendRecording(id: string, sequence: number, bytes: ArrayBuffer): Promise<RecordingResult>;
  finishRecording(id: string): Promise<RecordingResult>;
  abortRecording(id: string): Promise<RecordingResult>;
  openRecording(): Promise<RecordingResult>;
  authorizePreview(): Promise<boolean>;
  chooseFolder(): Promise<FolderResult>;
  checkFolder(): Promise<FolderResult>;
  openFolder(): Promise<{ ok: boolean; message?: string }>;
}

declare global { interface Window { blastcast: DesktopBridge } }
