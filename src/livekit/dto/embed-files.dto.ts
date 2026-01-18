import { IsString, IsNotEmpty, IsArray, ValidateNested } from 'class-validator';
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
  @IsNotEmpty()
  roomId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FileReference)
  files: FileReference[];

  @IsString()
  @IsNotEmpty()
  topic: string;
}
