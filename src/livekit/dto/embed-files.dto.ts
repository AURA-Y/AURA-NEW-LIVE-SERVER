import { IsString, IsNotEmpty, IsArray, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

class FileReference {
  @IsString()
  @IsNotEmpty()
  bucket: string;

  @IsString()
  @IsNotEmpty()
  key: string;
}

class ExpectedAttendee {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  nickName: string;
}

class ReferencedFile {
  @IsString()
  @IsNotEmpty()
  fileId: string;

  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsString()
  @IsNotEmpty()
  fileUrl: string;  // S3 presigned URL

  @IsOptional()
  fileSize?: number;

  @IsString()
  @IsOptional()
  createdAt?: string;

  @IsString()
  @IsOptional()
  sourceRoomId?: string;  // 원본 회의 ID
}

export class EmbedFilesDto {
  @IsString()
  @IsNotEmpty()
  roomId: string;

  @IsString()
  @IsOptional()
  channelId?: string;  // GitHub Project 등록 등에 사용

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FileReference)
  files: FileReference[];

  @IsString()
  @IsNotEmpty()
  topic: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExpectedAttendee)
  @IsOptional()
  expectedAttendees?: ExpectedAttendee[];  // 예정 참여자 (불참자 확인용)

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReferencedFile)
  @IsOptional()
  referencedFiles?: ReferencedFile[];  // 이전 회의에서 참조한 파일들
}
