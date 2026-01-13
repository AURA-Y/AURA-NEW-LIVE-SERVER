import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpException,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RecordingService } from './recording.service';
import { StopRecordingDto, RecordingStatus } from './dto/recording.dto';

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
  @UseInterceptors(FileInterceptor('file'))
  async uploadRecording(
    @Param('roomId') roomId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const normalizedRoomId = roomId.trim();

    if (!normalizedRoomId) {
      throw new HttpException('roomId is required', HttpStatus.BAD_REQUEST);
    }

    if (!file) {
      throw new HttpException('file is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const result = await this.recordingService.uploadClientRecording(
        normalizedRoomId,
        file,
      );

      return {
        success: true,
        roomId: normalizedRoomId,
        fileUrl: result.fileUrl,
        fileName: result.fileName,
        fileSize: result.fileSize,
        message: '녹화 파일이 업로드되었습니다.',
      };
    } catch (error) {
      throw new HttpException(
        `녹화 업로드 실패: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
