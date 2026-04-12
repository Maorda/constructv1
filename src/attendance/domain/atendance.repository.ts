export interface IAttendanceRepository<T> {
    registerUpdate(data: any): Promise<T>;
    findAll(query?: any): Promise<any[]>;
    findOne(query: Record<string, any>): Promise<T | null>;
    deleteOne(query: Record<string, any>): Promise<T | null>;
}
export const ATTENDANCE_REPOSITORY = 'IATTENDANCE_REPOSITORY';