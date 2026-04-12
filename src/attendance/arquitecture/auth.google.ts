import { Inject, Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { GoogleDriveConfig } from './auth.google.types';
export const enum EFOLDERSIDS {
    CONFIG = "CONFIG",
    FOLDERBASEID = "FOLDERBASEID",
}
@Injectable()
export class GoogleAutenticarService {
    public drive;
    public sheets;
    constructor(
        @Inject(EFOLDERSIDS.CONFIG) private config: GoogleDriveConfig,
        @Inject(EFOLDERSIDS.FOLDERBASEID) private googleDriveFolderBaseId: string,
    ) {
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: this.config.client_email,
                private_key: this.config.private_key,
            },
            scopes: [
                'https://www.googleapis.com/auth/drive',
                'https://www.googleapis.com/auth/drive.file',
                'https://www.googleapis.com/auth/drive.readonly',
                'https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/spreadsheets.readonly',
                'https://www.googleapis.com/auth/drive.file',
                'https://www.googleapis.com/auth/drive.metadata.readonly'
            ],
        });
        this.drive = google.drive({ version: 'v3', auth });
        this.sheets = google.sheets({ version: 'v4', auth })
    }
}