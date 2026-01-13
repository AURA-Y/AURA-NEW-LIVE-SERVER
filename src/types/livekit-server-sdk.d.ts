declare module 'livekit-server-sdk' {
  export class AccessToken {
    constructor(
      apiKey: string,
      apiSecret: string,
      options?: {
        identity?: string;
        ttl?: string | number;
      },
    );
    addGrant(grant: Record<string, unknown>): void;
    toJwt(): Promise<string>;
  }

  export class RoomServiceClient {
    constructor(url: string, apiKey: string, apiSecret: string);
    createRoom(options: Record<string, unknown>): Promise<any>;
    listRooms(): Promise<any[]>;
    deleteRoom(room: string): Promise<void>;
  }

  export class AgentDispatchClient {
    constructor(url: string, apiKey: string, apiSecret: string);
    listDispatch(roomName: string): Promise<any[]>;
    createDispatch(roomName: string, agentName: string): Promise<any>;
  }

  export class RoomAgentDispatch {
    constructor(options: { agentName: string });
  }

  // Egress 관련 타입
  export class EgressClient {
    constructor(url: string, apiKey: string, apiSecret: string);

    startRoomCompositeEgress(
      roomName: string,
      output: RoomCompositeEgressOutput,
      options?: RoomCompositeEgressOptions,
    ): Promise<EgressInfo>;

    stopEgress(egressId: string): Promise<EgressInfo>;

    listEgress(options?: { roomName?: string; egressId?: string }): Promise<EgressInfo[]>;
  }

  export interface RoomCompositeEgressOutput {
    file?: EncodedFileOutput;
    stream?: StreamOutput;
    segments?: SegmentedFileOutput;
  }

  export interface RoomCompositeEgressOptions {
    layout?: string;
    audioOnly?: boolean;
    videoOnly?: boolean;
    customBaseUrl?: string;
  }

  export interface StreamOutput {
    protocol?: StreamProtocol;
    urls?: string[];
  }

  export interface SegmentedFileOutput {
    protocol?: SegmentedFileProtocol;
    filenamePrefix?: string;
    playlistName?: string;
    segmentDuration?: number;
    output?: {
      case: 's3' | 'gcp' | 'azure' | 'aliOSS';
      value: S3Upload | GCPUpload | AzureBlobUpload | AliOSSUpload;
    };
  }

  export enum StreamProtocol {
    DEFAULT_PROTOCOL = 0,
    RTMP = 1,
  }

  export enum SegmentedFileProtocol {
    DEFAULT_SEGMENTED_FILE_PROTOCOL = 0,
    HLS_PROTOCOL = 1,
  }

  export class EncodedFileOutput {
    constructor(options: {
      fileType?: EncodedFileType;
      filepath?: string;
      output?: {
        case: 's3' | 'gcp' | 'azure' | 'aliOSS' | 'file';
        value: S3Upload | GCPUpload | AzureBlobUpload | AliOSSUpload | DirectFileOutput;
      };
    });
  }

  export enum EncodedFileType {
    DEFAULT_FILETYPE = 0,
    MP4 = 1,
    OGG = 2,
  }

  export class S3Upload {
    constructor(options: {
      accessKey?: string;
      secret?: string;
      bucket?: string;
      region?: string;
      endpoint?: string;
      forcePathStyle?: boolean;
    });
  }

  export class GCPUpload {
    constructor(options: {
      credentials?: string;
      bucket?: string;
    });
  }

  export class AzureBlobUpload {
    constructor(options: {
      accountName?: string;
      accountKey?: string;
      containerName?: string;
    });
  }

  export class AliOSSUpload {
    constructor(options: {
      accessKey?: string;
      secret?: string;
      bucket?: string;
      region?: string;
      endpoint?: string;
    });
  }

  export class DirectFileOutput {
    constructor(options?: {
      filepath?: string;
    });
  }

  export interface EgressInfo {
    egressId: string;
    roomId?: string;
    roomName?: string;
    status: EgressStatus;
    startedAt?: bigint;
    endedAt?: bigint;
    error?: string;
    fileResults?: FileInfo[];
    streamResults?: StreamInfo[];
    segmentResults?: SegmentsInfo[];
  }

  export interface FileInfo {
    filename?: string;
    startedAt?: bigint;
    endedAt?: bigint;
    duration?: bigint;
    size?: bigint;
    location?: string;
  }

  export interface StreamInfo {
    url?: string;
    startedAt?: bigint;
    endedAt?: bigint;
    duration?: bigint;
    status?: StreamInfoStatus;
    error?: string;
  }

  export interface SegmentsInfo {
    playlistName?: string;
    duration?: bigint;
    size?: bigint;
    playlistLocation?: string;
    segmentCount?: bigint;
    startedAt?: bigint;
    endedAt?: bigint;
  }

  export enum EgressStatus {
    EGRESS_STARTING = 0,
    EGRESS_ACTIVE = 1,
    EGRESS_ENDING = 2,
    EGRESS_COMPLETE = 3,
    EGRESS_FAILED = 4,
    EGRESS_ABORTED = 5,
    EGRESS_LIMIT_REACHED = 6,
  }

  export enum StreamInfoStatus {
    ACTIVE = 0,
    FINISHED = 1,
    FAILED = 2,
  }
}
