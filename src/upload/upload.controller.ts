import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  UseInterceptors,
  UploadedFile,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadService } from './upload.service';

@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  /**
   * 채팅 파일 업로드
   * POST /api/upload/:roomId/chat
   */
  @Post(':roomId/chat')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 50 * 1024 * 1024, // 50MB 제한
      },
    }),
  )
  async uploadChatFile(
    @Param('roomId') roomId: string,
    @UploadedFile() file: Express.Multer.File,
    @Query('uploaderName') uploaderName?: string,
  ) {
    if (!file) {
      throw new HttpException('No file provided', HttpStatus.BAD_REQUEST);
    }

    try {
      const result = await this.uploadService.uploadChatFile(
        roomId,
        file,
        uploaderName,
      );
      return result;
    } catch (error) {
      throw new HttpException(
        error.message || 'Upload failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 다운로드 URL 재생성
   * GET /api/upload/:roomId/download/:fileName
   */
  @Get(':roomId/download/:fileName')
  async getDownloadUrl(
    @Param('roomId') roomId: string,
    @Param('fileName') fileName: string,
    @Query('originalName') originalName?: string,
  ) {
    try {
      const downloadUrl = await this.uploadService.getDownloadUrl(
        roomId,
        fileName,
        originalName,
      );
      return { downloadUrl };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to generate download URL',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
