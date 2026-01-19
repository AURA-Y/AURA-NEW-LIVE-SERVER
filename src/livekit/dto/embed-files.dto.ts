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

export class EmbedFilesDto {
  @IsString()
  @IsNotEmpty()
  roomId: string;

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

  @IsString()
  @IsOptional()
  channelId?: string;  // 채널 ID (이전 회의록 검색용)

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  referencedRoomIds?: string[];  // Step 1에서 선택한 이전 회의록 ID 목록
}
