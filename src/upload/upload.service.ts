import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private s3Client: S3Client | null = null;

  private readonly s3Bucket: string;
  private readonly s3Region: string;
  private readonly s3AccessKey: string;
  private readonly s3SecretKey: string;
  private readonly s3Prefix: string = 'rooms/';

  /**
   * 파일명 디코딩 (multer가 Latin-1로 해석한 UTF-8 복구)
   */
  private decodeFileName(name: string): string {
    if (!name) return name;

    try {
      const bytes = Buffer.from(name, 'latin1');
      const decoded = bytes.toString('utf8');
      // 유효한 한글이 포함되어 있으면 복구된 것
      if (/[가-힣]/.test(decoded)) {
        return decoded;
      }
    } catch {
      // 복구 실패 시 원본 반환
    }

    return name;
  }

  constructor(private configService: ConfigService) {
    this.s3Bucket = this.configService.get<string>('AURA_S3_BUCKET') || 'aura-raw-data-bucket';
    this.s3Region = this.configService.get<string>('AWS_REGION') || 'ap-northeast-2';
    this.s3AccessKey = this.configService.get<string>('AWS_ACCESS_KEY_ID_S3') ||
                       this.configService.get<string>('AWS_ACCESS_KEY_ID');
    this.s3SecretKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY_S3') ||
                       this.configService.get<string>('AWS_SECRET_ACCESS_KEY');

    if (this.s3Bucket && this.s3AccessKey && this.s3SecretKey) {
      this.s3Client = new S3Client({
        region: this.s3Region,
        credentials: {
          accessKeyId: this.s3AccessKey,
          secretAccessKey: this.s3SecretKey,
        },
      });
      this.logger.log(`[Upload] S3 configured - bucket: ${this.s3Bucket}`);
    } else {
      this.logger.warn('[Upload] S3 credentials not configured');
    }
  }

  /**
   * 채팅 첨부 파일 S3 업로드
   */
  async uploadChatFile(
    roomId: string,
    file: Express.Multer.File,
    uploaderName?: string,
  ): Promise<{
    fileUrl: string;
    downloadUrl: string;
    fileName: string;
    fileSize: number;
    contentType: string;
  }> {
    if (!this.s3Client) {
      throw new Error('S3 not configured');
    }

    // 파일명 디코딩 (multer Latin-1 → UTF-8)
    const decodedFileName = this.decodeFileName(file.originalname);

    const timestamp = Date.now();
    // 원본 파일명 유지하면서 충돌 방지
    const safeFileName = decodedFileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const s3Key = `${this.s3Prefix}${roomId}/attachments/${timestamp}-${safeFileName}`;

    this.logger.log(`[Upload] Uploading chat file: ${decodedFileName} (${file.size} bytes)`);

    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.s3Bucket,
          Key: s3Key,
          Body: file.buffer,
          ContentType: file.mimetype || 'application/octet-stream',
          Metadata: {
            originalName: encodeURIComponent(decodedFileName),
            uploaderName: uploaderName ? encodeURIComponent(uploaderName) : 'unknown',
            roomId: roomId,
          },
        }),
      );

      const fileUrl = `https://${this.s3Bucket}.s3.${this.s3Region}.amazonaws.com/${s3Key}`;

      // 다운로드용 presigned URL 생성 (1시간 유효)
      const downloadUrl = await getSignedUrl(
        this.s3Client,
        new GetObjectCommand({
          Bucket: this.s3Bucket,
          Key: s3Key,
          ResponseContentDisposition: `attachment; filename="${encodeURIComponent(decodedFileName)}"`,
        }),
        { expiresIn: 3600 },
      );

      this.logger.log(`[Upload] File uploaded: ${fileUrl}`);

      return {
        fileUrl,
        downloadUrl,
        fileName: decodedFileName,
        fileSize: file.size,
        contentType: file.mimetype || 'application/octet-stream',
      };
    } catch (error) {
      this.logger.error(`[Upload] Failed: ${error.message}`);
      throw new Error(`Upload failed: ${error.message}`);
    }
  }

  /**
   * Presigned download URL 재생성
   */
  async getDownloadUrl(
    roomId: string,
    fileName: string,
    originalName?: string,
  ): Promise<string> {
    if (!this.s3Client) {
      throw new Error('S3 not configured');
    }

    // roomId/attachments/ 경로에서 파일 찾기
    const s3Key = `${this.s3Prefix}${roomId}/attachments/${fileName}`;

    const downloadUrl = await getSignedUrl(
      this.s3Client,
      new GetObjectCommand({
        Bucket: this.s3Bucket,
        Key: s3Key,
        ResponseContentDisposition: originalName
          ? `attachment; filename="${encodeURIComponent(originalName)}"`
          : undefined,
      }),
      { expiresIn: 3600 },
    );

    return downloadUrl;
  }

  /**
   * PDF 뷰어용 Presigned URL 생성 (inline 표시, attachment 헤더 없음)
   */
  async getViewerUrl(fileUrl: string): Promise<string> {
    if (!this.s3Client) {
      throw new Error('S3 not configured');
    }

    // S3 URL에서 key 추출
    // 형식: https://bucket.s3.region.amazonaws.com/key
    const url = new URL(fileUrl);
    const s3Key = decodeURIComponent(url.pathname.slice(1)); // 앞의 / 제거

    this.logger.log(`[Upload] Generating viewer URL for key: ${s3Key}`);

    const viewerUrl = await getSignedUrl(
      this.s3Client,
      new GetObjectCommand({
        Bucket: this.s3Bucket,
        Key: s3Key,
        // ResponseContentDisposition 없음 - inline 표시
      }),
      { expiresIn: 3600 },
    );

    return viewerUrl;
  }
}
