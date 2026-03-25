import { Module } from '@nestjs/common';
import { ExecController } from './exec.controller';
import { ExecService } from './exec.service';

@Module({
  controllers: [ExecController],
  providers: [ExecService],
  exports: [ExecService],
})
export class ExecModule {}
