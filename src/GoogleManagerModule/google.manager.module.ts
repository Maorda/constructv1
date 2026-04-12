import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DynamicModule } from '@nestjs/common';
import { EFOLDERSIDS, GoogleAutenticarService } from './arquitecture/auth.google.service';
import { GoogleDriveConfig } from './arquitecture/auth.google.types';
import { GoogleSpreedsheetService } from './arquitecture/google.spreedsheet.service';
@Module({
    imports: [HttpModule],
})
export class GoogledrivecasaModule {
    /**
   * @param googleDriveConfig your config file/all config fields
   * @param googleDriveFolderId your Google Drive folder id
   */
    static register(
        googleDriveConfig: GoogleDriveConfig,
        googleDriveBaseFolderId: string,//carpeta base en donde se lojara todos los archivos de los usuarios
    ): DynamicModule {
        return {
            module: GoogledrivecasaModule,
            global: true,
            providers: [
                GoogleAutenticarService,
                GoogleSpreedsheetService,
                { provide: EFOLDERSIDS.CONFIG, useValue: googleDriveConfig },
                { provide: EFOLDERSIDS.FOLDERBASEID, useValue: googleDriveBaseFolderId },
            ],
            exports: [
                GoogleAutenticarService,
                GoogleSpreedsheetService,
                { provide: EFOLDERSIDS.CONFIG, useValue: googleDriveConfig },
                { provide: EFOLDERSIDS.FOLDERBASEID, useValue: googleDriveBaseFolderId },
            ],
        };
    }
}