/**
 * Recording DTOs
 * 녹화 관련 데이터 전송 객체
 */

export class StartRecordingDto {
  roomId: string;
  userId?: string;
  layout?: 'grid' | 'speaker' | 'single-speaker';
}

export class StopRecordingDto {
  egressId: string;
}

export interface RecordingResult {
  egressId: string;
  fileUrl?: string;
  duration?: number;
  status: RecordingStatus;
}

export interface RecordingInfo {
  egressId: string;
  roomId: string;
  status: RecordingStatus;
  startedAt: Date;
  duration?: number;
}

export enum RecordingStatus {
  STARTING = 'starting',
  RECORDING = 'recording',
  STOPPING = 'stopping',
  COMPLETED = 'completed',
  FAILED = 'failed',
}
