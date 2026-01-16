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
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  RecordingResult,
  RecordingInfo,
  RecordingStatus,
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
  ): Promise<{ fileUrl: string; fileName: string; fileSize: number }> {
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
      this.logger.log(`========== [S3 업로드 성공] ==========\n`);

      return {
        fileUrl,
        fileName,
        fileSize: file.size,
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
}
