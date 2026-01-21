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

/**
 * 비디오 챕터 (구간 표시)
 * - 회의록 요약에서 추출된 논의/결정/액션 아이템 타임스탬프
 */
export interface VideoChapter {
  title: string;
  startTime: number; // 초 단위
  endTime?: number;
}

/**
 * 녹화 메타데이터 (S3에 JSON으로 저장)
 */
export interface RecordingMetadata {
  roomId: string;
  fileName: string;
  fileUrl: string;
  fileSize: number;
  duration?: number;
  recordingStartTime?: number; // 녹화 시작 시간 (밀리초 타임스탬프)
  chapters?: VideoChapter[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 챕터 업데이트 요청 DTO
 */
export class UpdateChaptersDto {
  fileName: string;
  chapters: VideoChapter[];
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
