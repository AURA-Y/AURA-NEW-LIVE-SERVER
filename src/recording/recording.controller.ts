import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  HttpException,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { RecordingService } from './recording.service';
import { StopRecordingDto, RecordingStatus, UpdateChaptersDto } from './dto/recording.dto';

@Controller('room/:roomId/recording')
export class RecordingController {
  constructor(private readonly recordingService: RecordingService) {}

  /**
   * 녹화 시작
   * POST /room/:roomId/recording/start
   */
  @Post('start')
  async startRecording(
    @Param('roomId') roomId: string,
    @Body('layout') layout?: 'grid' | 'speaker' | 'single-speaker',
  ) {
    const normalizedRoomId = roomId.trim();

    if (!normalizedRoomId) {
      throw new HttpException('roomId is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const result = await this.recordingService.startRecording(
        normalizedRoomId,
        layout || 'grid',
      );

      return {
        success: true,
        roomId: normalizedRoomId,
        egressId: result.egressId,
        status: result.status,
        message: `녹화가 시작되었습니다.`,
      };
    } catch (error) {
      throw new HttpException(
        `녹화 시작 실패: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 녹화 중지
   * POST /room/:roomId/recording/stop
   */
  @Post('stop')
  async stopRecording(
    @Param('roomId') roomId: string,
    @Body() body?: StopRecordingDto,
  ) {
    const normalizedRoomId = roomId.trim();

    if (!normalizedRoomId) {
      throw new HttpException('roomId is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const result = await this.recordingService.stopRecording(normalizedRoomId);

      return {
        success: true,
        roomId: normalizedRoomId,
        egressId: result.egressId,
        fileUrl: result.fileUrl,
        duration: result.duration,
        status: result.status,
        message: `녹화가 완료되었습니다. (${result.duration}초)`,
      };
    } catch (error) {
      throw new HttpException(
        `녹화 중지 실패: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 녹화 상태 조회
   * GET /room/:roomId/recording/status
   */
  @Get('status')
  async getRecordingStatus(@Param('roomId') roomId: string) {
    const normalizedRoomId = roomId.trim();

    if (!normalizedRoomId) {
      throw new HttpException('roomId is required', HttpStatus.BAD_REQUEST);
    }

    const status = await this.recordingService.getRecordingStatus(normalizedRoomId);

    if (!status) {
      return {
        isRecording: false,
        roomId: normalizedRoomId,
        status: RecordingStatus.COMPLETED,
        message: '현재 녹화 중이 아닙니다.',
      };
    }

    return {
      isRecording: true,
      roomId: normalizedRoomId,
      egressId: status.egressId,
      status: status.status,
      startedAt: status.startedAt,
      duration: status.duration,
      message: `녹화 중 (${status.duration}초 경과)`,
    };
  }

  /**
   * 방의 Egress 목록 조회
   * GET /room/:roomId/recording/list
   */
  @Get('list')
  async listRecordings(@Param('roomId') roomId: string) {
    const normalizedRoomId = roomId.trim();

    if (!normalizedRoomId) {
      throw new HttpException('roomId is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const egresses = await this.recordingService.listRoomEgresses(normalizedRoomId);

      return {
        success: true,
        roomId: normalizedRoomId,
        recordings: egresses.map((egress) => ({
          egressId: egress.egressId,
          status: egress.status,
          startedAt: egress.startedAt,
          endedAt: egress.endedAt,
          fileResults: egress.fileResults,
        })),
        total: egresses.length,
      };
    } catch (error) {
      throw new HttpException(
        `녹화 목록 조회 실패: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 클라이언트 측 녹화 파일 업로드
   * POST /room/:roomId/recording/upload
   */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: 500 * 1024 * 1024, // 500MB 제한 (녹화 파일은 클 수 있음)
      },
    }),
  )
  async uploadRecording(
    @Param('roomId') roomId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('recordingStartTime') recordingStartTimeStr?: string,
  ) {
    // recordingStartTime을 숫자로 변환 (밀리초 타임스탬프)
    const recordingStartTime = recordingStartTimeStr ? parseInt(recordingStartTimeStr, 10) : undefined;

    console.log(`\n========== [녹화 업로드 API] ==========`);
    console.log(`[1] 요청 수신 - roomId: ${roomId}, recordingStartTime: ${recordingStartTime}`);
    console.log(`[2] 파일 정보:`, file ? {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      bufferLength: file.buffer?.length || 0,
      hasBuffer: !!file.buffer,
    } : 'file is null/undefined');

    const normalizedRoomId = roomId?.trim();

    if (!normalizedRoomId) {
      console.error(`[ERROR] roomId 누락`);
      throw new HttpException('roomId is required', HttpStatus.BAD_REQUEST);
    }

    if (!file) {
      console.error(`[ERROR] 파일 누락 - Content-Type 헤더가 multipart/form-data인지 확인 필요`);
      throw new HttpException(
        'file is required. Ensure Content-Type is multipart/form-data and field name is "file"',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!file.buffer || file.buffer.length === 0) {
      console.error(`[ERROR] file.buffer가 없거나 비어있음`);
      console.error(`  - buffer exists: ${!!file.buffer}`);
      console.error(`  - buffer length: ${file.buffer?.length || 0}`);
      throw new HttpException(
        'File buffer is empty. Server configuration error.',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    console.log(`[3] 유효성 검사 통과, S3 업로드 시작...`);

    try {
      const result = await this.recordingService.uploadClientRecording(
        normalizedRoomId,
        file,
        recordingStartTime,
      );

      console.log(`[4] S3 업로드 성공`);
      console.log(`  - fileUrl: ${result.fileUrl}`);
      console.log(`  - fileName: ${result.fileName}`);
      console.log(`  - fileSize: ${result.fileSize}`);
      console.log(`  - recordingStartTime: ${result.recordingStartTime}`);
      console.log(`========== [녹화 업로드 완료] ==========\n`);

      return {
        success: true,
        roomId: normalizedRoomId,
        fileUrl: result.fileUrl,
        fileName: result.fileName,
        fileSize: result.fileSize,
        recordingStartTime: result.recordingStartTime,
        message: '녹화 파일이 업로드되었습니다.',
      };
    } catch (error) {
      console.error(`\n[ERROR] 녹화 업로드 실패`);
      console.error(`  - Error name: ${error.name}`);
      console.error(`  - Error message: ${error.message}`);
      console.error(`  - Stack trace:`, error.stack);
      console.error(`========== [녹화 업로드 실패] ==========\n`);
      throw new HttpException(
        `녹화 업로드 실패: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 녹화 챕터 업데이트
   * PATCH /room/:roomId/recording/chapters
   */
  @Patch('chapters')
  async updateChapters(
    @Param('roomId') roomId: string,
    @Body() body: UpdateChaptersDto,
  ) {
    const normalizedRoomId = roomId?.trim();

    if (!normalizedRoomId) {
      throw new HttpException('roomId is required', HttpStatus.BAD_REQUEST);
    }

    if (!body.fileName) {
      throw new HttpException('fileName is required', HttpStatus.BAD_REQUEST);
    }

    if (!body.chapters || !Array.isArray(body.chapters)) {
      throw new HttpException('chapters array is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const result = await this.recordingService.updateRecordingChapters(
        normalizedRoomId,
        body.fileName,
        body.chapters,
      );

      return {
        success: result.success,
        roomId: normalizedRoomId,
        fileName: body.fileName,
        chaptersCount: body.chapters.length,
        message: result.message,
      };
    } catch (error) {
      throw new HttpException(
        `챕터 업데이트 실패: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 녹화 챕터 조회
   * GET /room/:roomId/recording/chapters/:fileName
   */
  @Get('chapters/:fileName')
  async getChapters(
    @Param('roomId') roomId: string,
    @Param('fileName') fileName: string,
  ) {
    const normalizedRoomId = roomId?.trim();

    if (!normalizedRoomId) {
      throw new HttpException('roomId is required', HttpStatus.BAD_REQUEST);
    }

    if (!fileName) {
      throw new HttpException('fileName is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const chapters = await this.recordingService.getRecordingChapters(
        normalizedRoomId,
        fileName,
      );

      return {
        success: true,
        roomId: normalizedRoomId,
        fileName,
        chapters,
        total: chapters.length,
      };
    } catch (error) {
      throw new HttpException(
        `챕터 조회 실패: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 녹화 메타데이터 조회
   * GET /room/:roomId/recording/metadata/:fileName
   */
  @Get('metadata/:fileName')
  async getMetadata(
    @Param('roomId') roomId: string,
    @Param('fileName') fileName: string,
  ) {
    const normalizedRoomId = roomId?.trim();

    if (!normalizedRoomId) {
      throw new HttpException('roomId is required', HttpStatus.BAD_REQUEST);
    }

    if (!fileName) {
      throw new HttpException('fileName is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const metadata = await this.recordingService.getRecordingMetadata(
        normalizedRoomId,
        fileName,
      );

      if (!metadata) {
        return {
          success: false,
          roomId: normalizedRoomId,
          fileName,
          message: '메타데이터를 찾을 수 없습니다.',
        };
      }

      return {
        success: true,
        roomId: normalizedRoomId,
        metadata,
      };
    } catch (error) {
      throw new HttpException(
        `메타데이터 조회 실패: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
