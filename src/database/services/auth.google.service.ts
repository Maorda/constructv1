import { GoogleDriveConfig } from '@database/interfaces/database.options.interface';
import { Inject, Injectable } from '@nestjs/common';
import { google } from 'googleapis';


@Injectable()
export class GoogleAutenticarService {
    public drive;
    public sheets;
    constructor(
        @Inject("CONFIG") private config: GoogleDriveConfig,
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