import { IsString, IsNotEmpty } from 'class-validator';

export class LinkReportDto {
  @IsString()
  @IsNotEmpty()
  roomId: string;

  @IsString()
  @IsNotEmpty()
  reportId: string;
}
