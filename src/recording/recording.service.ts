import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  EgressInfo,
  S3Upload,
  DirectFileOutput,
} from 'livekit-server-sdk';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import axios from 'axios';
import {
  RecordingResult,
  RecordingInfo,
  RecordingStatus,
  RecordingMetadata,
  VideoChapter,
} from './dto/recording.dto';

@Injectable()
export class RecordingService {
  private readonly logger = new Logger(RecordingService.name);
  private egressClient: EgressClient;

  // roomId -> { egressId, startedAt }
  private activeRecordings: Map<
    string,
    { egressId: string; startedAt: Date }
  > = new Map();

  // S3 설정 (AURA_NEW_RESTAPI와 동일)
  private readonly s3Bucket: string;
  private readonly s3Region: string;
  private readonly s3AccessKey: string;
  private readonly s3SecretKey: string;
  private readonly s3Prefix: string = 'rooms/'; // AURA_NEW_RESTAPI와 동일

  // RAG API 설정
  private readonly ragApiUrl: string;

  constructor(private configService: ConfigService) {
    const livekitUrl = this.configService.get<string>('LIVEKIT_URL');
    const apiKey = this.configService.get<string>('LIVEKIT_API_KEY');
    const apiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');

    // S3 설정 로드 (AURA_NEW_RESTAPI/.env와 동일한 키 사용)
    this.s3Bucket = this.configService.get<string>('AURA_S3_BUCKET') || 'aura-raw-data-bucket';
    this.s3Region = this.configService.get<string>('AWS_REGION') || 'ap-northeast-2';
    this.s3AccessKey = this.configService.get<string>('AWS_ACCESS_KEY_ID_S3') ||
                       this.configService.get<string>('AWS_ACCESS_KEY_ID');
    this.s3SecretKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY_S3') ||
                       this.configService.get<string>('AWS_SECRET_ACCESS_KEY');

    if (!livekitUrl || !apiKey || !apiSecret) {
      this.logger.warn(
        'LiveKit credentials not configured. Recording will not work.',
      );
    } else {
      this.egressClient = new EgressClient(livekitUrl, apiKey, apiSecret);
      this.logger.log('EgressClient initialized successfully');
    }

    // S3 설정 로깅
    if (this.s3Bucket && this.s3AccessKey) {
      this.logger.log(`[S3] Bucket: ${this.s3Bucket}, Region: ${this.s3Region}`);
    } else {
      this.logger.warn('[S3] S3 credentials not configured. Will use local storage.');
    }

    // RAG API URL 설정
    this.ragApiUrl = this.configService.get<string>('RAG_API_URL') || 'http://localhost:8000';
    this.logger.log(`[RAG] API URL: ${this.ragApiUrl}`);
  }

  /**
   * S3 녹화 파일 경로 생성
   * 형식: rooms/{roomId}/recordings/{timestamp}.mp4
   * 예: rooms/room-1234567890-abc123/recordings/1705123456789.mp4
   */
  private getRecordingS3Path(roomId: string): string {
    const timestamp = Date.now();
    return `${this.s3Prefix}${roomId}/recordings/${timestamp}.mp4`;
  }

  /**
   * 방의 RoomComposite 녹화 시작
   */
  async startRecording(
    roomId: string,
    layout: 'grid' | 'speaker' | 'single-speaker' = 'grid',
  ): Promise<{ egressId: string; status: RecordingStatus }> {
    if (!this.egressClient) {
      throw new Error('EgressClient not initialized. Check LiveKit credentials.');
    }

    // 이미 녹화 중인지 확인
    if (this.activeRecordings.has(roomId)) {
      throw new Error(`Room ${roomId} is already being recorded`);
    }

    this.logger.log(`[녹화 시작] roomId: ${roomId}, layout: ${layout}`);

    try {
      let output: EncodedFileOutput;

      if (this.s3Bucket && this.s3AccessKey && this.s3SecretKey) {
        // S3 저장 (AURA_NEW_RESTAPI와 동일한 버킷 사용)
        const s3Path = this.getRecordingS3Path(roomId);
        this.logger.log(`[녹화] S3 저장 설정 - bucket: ${this.s3Bucket}, path: ${s3Path}`);
        
        output = new EncodedFileOutput({
          fileType: EncodedFileType.MP4,
          filepath: s3Path,
          output: {
            case: 's3',
            value: new S3Upload({
              bucket: this.s3Bucket,
              region: this.s3Region,
              accessKey: this.s3AccessKey,
              secret: this.s3SecretKey,
            }),
          },
        });
      } else {
        // 로컬 파일 저장 (개발 환경용)
        this.logger.log('[녹화] 로컬 파일 저장 설정');
        const localPath = this.configService.get<string>('RECORDING_LOCAL_PATH') || '/tmp/recordings';
        const timestamp = Date.now();
        output = new EncodedFileOutput({
          fileType: EncodedFileType.MP4,
          filepath: `${localPath}/${roomId}/recordings/${timestamp}.mp4`,
          output: {
            case: 'file',
            value: new DirectFileOutput({}),
          },
        });
      }

      // RoomComposite Egress 시작
      const egress = await this.egressClient.startRoomCompositeEgress(
        roomId,
        {
          file: output,
        },
        {
          layout,
          audioOnly: false,
        },
      );

      const egressId = egress.egressId;
      this.activeRecordings.set(roomId, {
        egressId,
        startedAt: new Date(),
      });

      this.logger.log(`[녹화 시작 완료] egressId: ${egressId}`);

      return {
        egressId,
        status: RecordingStatus.RECORDING,
      };
    } catch (error) {
      this.logger.error(`[녹화 시작 실패] ${error.message}`);
      throw new Error(`Failed to start recording: ${error.message}`);
    }
  }

  /**
   * 녹화 중지
   */
  async stopRecording(roomId: string): Promise<RecordingResult> {
    if (!this.egressClient) {
      throw new Error('EgressClient not initialized');
    }

    const recording = this.activeRecordings.get(roomId);
    if (!recording) {
      throw new Error(`No active recording found for room ${roomId}`);
    }

    this.logger.log(`[녹화 중지] roomId: ${roomId}, egressId: ${recording.egressId}`);

    try {
      const result = await this.egressClient.stopEgress(recording.egressId);
      this.activeRecordings.delete(roomId);

      // 녹화 시간 계산
      const duration = Math.floor(
        (Date.now() - recording.startedAt.getTime()) / 1000,
      );

      // 파일 URL 추출
      let fileUrl: string | undefined;
      if (result.fileResults && result.fileResults.length > 0) {
        fileUrl = result.fileResults[0].location;
      }

      this.logger.log(`[녹화 중지 완료] duration: ${duration}s, fileUrl: ${fileUrl}`);

      return {
        egressId: recording.egressId,
        fileUrl,
        duration,
        status: RecordingStatus.COMPLETED,
      };
    } catch (error) {
      this.logger.error(`[녹화 중지 실패] ${error.message}`);
      this.activeRecordings.delete(roomId);
      throw new Error(`Failed to stop recording: ${error.message}`);
    }
  }

  /**
   * 녹화 상태 조회
   */
  async getRecordingStatus(roomId: string): Promise<RecordingInfo | null> {
    const recording = this.activeRecordings.get(roomId);
    if (!recording) {
      return null;
    }

    const duration = Math.floor(
      (Date.now() - recording.startedAt.getTime()) / 1000,
    );

    return {
      egressId: recording.egressId,
      roomId,
      status: RecordingStatus.RECORDING,
      startedAt: recording.startedAt,
      duration,
    };
  }

  /**
   * 특정 Egress 정보 조회
   */
  async getEgressInfo(egressId: string): Promise<EgressInfo | null> {
    if (!this.egressClient) {
      return null;
    }

    try {
      const egresses = await this.egressClient.listEgress({ egressId });
      return egresses.length > 0 ? egresses[0] : null;
    } catch (error) {
      this.logger.warn(`Failed to get egress info: ${error.message}`);
      return null;
    }
  }

  /**
   * 방의 모든 Egress 목록 조회
   */
  async listRoomEgresses(roomId: string): Promise<EgressInfo[]> {
    if (!this.egressClient) {
      return [];
    }

    try {
      return await this.egressClient.listEgress({ roomName: roomId });
    } catch (error) {
      this.logger.warn(`Failed to list room egresses: ${error.message}`);
      return [];
    }
  }

  /**
   * 활성 녹화 목록 조회
   */
  getActiveRecordings(): Map<string, { egressId: string; startedAt: Date }> {
    return this.activeRecordings;
  }

  /**
   * 특정 방이 녹화 중인지 확인
   */
  isRecording(roomId: string): boolean {
    return this.activeRecordings.has(roomId);
  }

  /**
   * 클라이언트 측 녹화 파일 S3 업로드
   */
  async uploadClientRecording(
    roomId: string,
    file: Express.Multer.File,
    recordingStartTime?: number,
  ): Promise<{ fileUrl: string; fileName: string; fileSize: number; recordingStartTime?: number }> {
    this.logger.log(`\n========== [S3 업로드 서비스] ==========`);
    this.logger.log(`[1] 입력 데이터:`);
    this.logger.log(`  - roomId: ${roomId}`);
    this.logger.log(`  - fileName: ${file?.originalname}`);
    this.logger.log(`  - size: ${file?.size} bytes`);
    this.logger.log(`  - mimetype: ${file?.mimetype}`);
    this.logger.log(`  - bufferLength: ${file?.buffer?.length || 0} bytes`);

    // S3 설정 확인 (디버깅용)
    this.logger.log(`[2] S3 설정 확인:`);
    this.logger.log(`  - bucket: ${this.s3Bucket || 'NOT SET'}`);
    this.logger.log(`  - region: ${this.s3Region || 'NOT SET'}`);
    this.logger.log(`  - accessKey: ${this.s3AccessKey ? `${this.s3AccessKey.substring(0, 4)}***` : 'NOT SET'}`);
    this.logger.log(`  - secretKey: ${this.s3SecretKey ? '***SET***' : 'NOT SET'}`);

    if (!this.s3Bucket || !this.s3AccessKey || !this.s3SecretKey) {
      this.logger.error(`[ERROR] S3 credentials not configured`);
      this.logger.error(`  환경변수 확인 필요:`);
      this.logger.error(`  - AURA_S3_BUCKET: ${process.env.AURA_S3_BUCKET || 'NOT SET'}`);
      this.logger.error(`  - AWS_ACCESS_KEY_ID_S3: ${process.env.AWS_ACCESS_KEY_ID_S3 ? 'SET' : 'NOT SET'}`);
      this.logger.error(`  - AWS_ACCESS_KEY_ID: ${process.env.AWS_ACCESS_KEY_ID ? 'SET' : 'NOT SET'}`);
      this.logger.error(`  - AWS_SECRET_ACCESS_KEY_S3: ${process.env.AWS_SECRET_ACCESS_KEY_S3 ? 'SET' : 'NOT SET'}`);
      this.logger.error(`  - AWS_SECRET_ACCESS_KEY: ${process.env.AWS_SECRET_ACCESS_KEY ? 'SET' : 'NOT SET'}`);
      throw new Error('S3 credentials not configured. Check AURA_S3_BUCKET, AWS_ACCESS_KEY_ID_S3/AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY_S3/AWS_SECRET_ACCESS_KEY environment variables.');
    }

    const timestamp = Date.now();
    const fileName = `recording-${timestamp}.webm`;
    const s3Key = `${this.s3Prefix}${roomId}/recordings/${fileName}`;

    this.logger.log(`[3] S3 업로드 준비:`);
    this.logger.log(`  - s3Key: ${s3Key}`);
    this.logger.log(`  - bucket: ${this.s3Bucket}`);

    try {
      const s3Client = new S3Client({
        region: this.s3Region,
        credentials: {
          accessKeyId: this.s3AccessKey,
          secretAccessKey: this.s3SecretKey,
        },
      });

      this.logger.log(`[4] S3Client 생성 완료, PutObjectCommand 실행 중...`);

      await s3Client.send(
        new PutObjectCommand({
          Bucket: this.s3Bucket,
          Key: s3Key,
          Body: file.buffer,
          ContentType: file.mimetype || 'video/webm',
        }),
      );

      const fileUrl = `https://${this.s3Bucket}.s3.${this.s3Region}.amazonaws.com/${s3Key}`;

      this.logger.log(`[5] S3 업로드 완료!`);
      this.logger.log(`  - fileUrl: ${fileUrl}`);
      this.logger.log(`  - recordingStartTime: ${recordingStartTime}`);

      // 메타데이터 자동 생성 (recordingStartTime 포함)
      await this.createRecordingMetadata(roomId, fileName, fileUrl, file.size, recordingStartTime);

      this.logger.log(`========== [S3 업로드 성공] ==========\n`);

      return {
        fileUrl,
        fileName,
        fileSize: file.size,
        recordingStartTime,
      };
    } catch (error) {
      this.logger.error(`\n[ERROR] S3 업로드 실패`);
      this.logger.error(`  - Error name: ${error.name}`);
      this.logger.error(`  - Error message: ${error.message}`);
      this.logger.error(`  - Error code: ${error.Code || error.code || 'N/A'}`);
      this.logger.error(`  - HTTP status: ${error.$metadata?.httpStatusCode || 'N/A'}`);
      if (error.stack) {
        this.logger.error(`  - Stack: ${error.stack}`);
      }
      this.logger.error(`========== [S3 업로드 실패] ==========\n`);
      throw new Error(`S3 upload failed: ${error.message}`);
    }
  }

  /**
   * 녹화 메타데이터 S3 키 생성
   * 형식: rooms/{roomId}/recordings/{fileName}.meta.json
   */
  private getMetadataS3Key(roomId: string, fileName: string): string {
    return `${this.s3Prefix}${roomId}/recordings/${fileName}.meta.json`;
  }

  /**
   * S3 클라이언트 생성 (재사용)
   */
  private getS3Client(): S3Client {
    return new S3Client({
      region: this.s3Region,
      credentials: {
        accessKeyId: this.s3AccessKey,
        secretAccessKey: this.s3SecretKey,
      },
    });
  }

  /**
   * 녹화 메타데이터 조회
   */
  async getRecordingMetadata(
    roomId: string,
    fileName: string,
  ): Promise<RecordingMetadata | null> {
    if (!this.s3Bucket || !this.s3AccessKey || !this.s3SecretKey) {
      this.logger.warn('[메타데이터 조회] S3 credentials not configured');
      return null;
    }

    const s3Key = this.getMetadataS3Key(roomId, fileName);

    try {
      const s3Client = this.getS3Client();
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: this.s3Bucket,
          Key: s3Key,
        }),
      );

      const bodyString = await response.Body?.transformToString();
      if (!bodyString) return null;

      return JSON.parse(bodyString) as RecordingMetadata;
    } catch (error) {
      if (error.name === 'NoSuchKey') {
        this.logger.debug(`[메타데이터 조회] 파일 없음: ${s3Key}`);
        return null;
      }
      this.logger.warn(`[메타데이터 조회 실패] ${error.message}`);
      return null;
    }
  }

  /**
   * 녹화 메타데이터 저장
   */
  async saveRecordingMetadata(
    roomId: string,
    metadata: RecordingMetadata,
  ): Promise<boolean> {
    if (!this.s3Bucket || !this.s3AccessKey || !this.s3SecretKey) {
      this.logger.warn('[메타데이터 저장] S3 credentials not configured');
      return false;
    }

    const s3Key = this.getMetadataS3Key(roomId, metadata.fileName);

    try {
      const s3Client = this.getS3Client();
      await s3Client.send(
        new PutObjectCommand({
          Bucket: this.s3Bucket,
          Key: s3Key,
          Body: JSON.stringify(metadata, null, 2),
          ContentType: 'application/json',
        }),
      );

      this.logger.log(`[메타데이터 저장 완료] ${s3Key}`);
      return true;
    } catch (error) {
      this.logger.error(`[메타데이터 저장 실패] ${error.message}`);
      return false;
    }
  }

  /**
   * 녹화에 챕터 업데이트
   */
  async updateRecordingChapters(
    roomId: string,
    fileName: string,
    chapters: VideoChapter[],
  ): Promise<{ success: boolean; message?: string }> {
    this.logger.log(`[챕터 업데이트] roomId: ${roomId}, fileName: ${fileName}, chapters: ${chapters.length}개`);

    // 기존 메타데이터 조회
    let metadata = await this.getRecordingMetadata(roomId, fileName);

    if (!metadata) {
      // 메타데이터가 없으면 새로 생성
      const fileUrl = `https://${this.s3Bucket}.s3.${this.s3Region}.amazonaws.com/${this.s3Prefix}${roomId}/recordings/${fileName}`;
      metadata = {
        roomId,
        fileName,
        fileUrl,
        fileSize: 0,
        chapters: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    // 챕터 업데이트
    metadata.chapters = chapters;
    metadata.updatedAt = new Date().toISOString();

    // 저장
    const success = await this.saveRecordingMetadata(roomId, metadata);

    return {
      success,
      message: success
        ? `${chapters.length}개 챕터가 저장되었습니다.`
        : '챕터 저장에 실패했습니다.',
    };
  }

  /**
   * 녹화 챕터 조회
   */
  async getRecordingChapters(
    roomId: string,
    fileName: string,
  ): Promise<VideoChapter[]> {
    const metadata = await this.getRecordingMetadata(roomId, fileName);
    return metadata?.chapters || [];
  }

  /**
   * 클라이언트 녹화 업로드 후 메타데이터 자동 생성
   */
  async createRecordingMetadata(
    roomId: string,
    fileName: string,
    fileUrl: string,
    fileSize: number,
    recordingStartTime?: number,
  ): Promise<RecordingMetadata> {
    const metadata: RecordingMetadata = {
      roomId,
      fileName,
      fileUrl,
      fileSize,
      recordingStartTime,
      chapters: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.saveRecordingMetadata(roomId, metadata);
    return metadata;
  }

  /**
   * RAG API에서 비디오 챕터 가져와서 S3에 저장
   * @param roomId 회의실 ID
   * @param fileName 녹화 파일명
   * @param recordingStartTime 녹화 시작 시간 (밀리초)
   */
  async fetchAndSaveChaptersFromRAG(
    roomId: string,
    fileName: string,
    recordingStartTime?: number,
  ): Promise<{ success: boolean; chapters: VideoChapter[]; message?: string }> {
    this.logger.log(`[RAG 챕터] roomId: ${roomId}, fileName: ${fileName}, recordingStartTime: ${recordingStartTime}`);

    try {
      // RAG API 호출
      const params: Record<string, string> = {
        sections: 'discussion,decision,action',
      };
      if (recordingStartTime) {
        params.recordingStartTime = String(recordingStartTime);
      }

      const response = await axios.get(
        `${this.ragApiUrl}/meetings/${roomId}/video-chapters`,
        { params, timeout: 30000 },
      );

      const data = response.data;

      if (data.status !== 'success' || !data.chapters || data.chapters.length === 0) {
        this.logger.warn(`[RAG 챕터] 추출된 챕터 없음: ${data.message || 'No chapters'}`);
        return {
          success: true,
          chapters: [],
          message: data.message || '추출된 챕터가 없습니다.',
        };
      }

      // RAG 응답을 VideoChapter 형식으로 변환
      const chapters: VideoChapter[] = data.chapters.map((ch: any, index: number, arr: any[]) => ({
        title: `[${this.getSectionLabel(ch.section)}] ${ch.title}`,
        startTime: ch.startTime,
        endTime: index < arr.length - 1 ? arr[index + 1].startTime : undefined,
      }));

      this.logger.log(`[RAG 챕터] ${chapters.length}개 챕터 추출 완료`);

      // S3 메타데이터에 저장
      const result = await this.updateRecordingChapters(roomId, fileName, chapters);

      return {
        success: result.success,
        chapters,
        message: result.message,
      };
    } catch (error) {
      this.logger.error(`[RAG 챕터 실패] ${error.message}`);
      return {
        success: false,
        chapters: [],
        message: `RAG API 호출 실패: ${error.message}`,
      };
    }
  }

  /**
   * 섹션 라벨 변환
   */
  private getSectionLabel(section: string): string {
    switch (section) {
      case 'discussion': return '논의';
      case 'decision': return '결정';
      case 'action': return '액션';
      default: return '';
    }
  }
}
