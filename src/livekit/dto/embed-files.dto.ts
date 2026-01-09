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

export class EmbedFilesDto {
  @IsString()
  @IsOptional()
  roomName?: string;

  @IsString()
  @IsOptional()
  roomId?: string;

  @IsString()
  @IsOptional()
  roomTitle?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => FileReference)
  files?: FileReference[];

  @IsString()
  @IsOptional()
  topic?: string;

  @IsString()
  @IsOptional()
  description?: string;
}
