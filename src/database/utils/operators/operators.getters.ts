export class OperatorsGettersHandleUtil {

    static getters: any = {
        /** Extrae el año (YYYY) */
        year: (date: any): number => {
            const d = new Date(date);
            return isNaN(d.getTime()) ? 0 : d.getFullYear();
        },

        /** Extrae el mes (1-12) */
        month: (date: any): number => {
            const d = new Date(date);
            return isNaN(d.getTime()) ? 0 : d.getMonth() + 1;
        },

        /** Extrae el día del mes (1-31) */
        day: (date: any): number => {
            const d = new Date(date);
            return isNaN(d.getTime()) ? 0 : d.getDate();
        },

        /** Extrae la hora (0-23) */
        hour: (date: any): number => {
            const d = new Date(date);
            return isNaN(d.getTime()) ? 0 : d.getHours();
        },

        /** * $minute: Extrae los minutos (0-59) 
         */
        minute: (date: any): number => {
            const d = new Date(date);
            return isNaN(d.getTime()) ? 0 : d.getMinutes();
        },

        /** * $second: Extrae los segundos (0-59) 
         */
        second: (date: any): number => {
            const d = new Date(date);
            return isNaN(d.getTime()) ? 0 : d.getSeconds();
        },

        /** * $dayOfWeek: Día de la semana (1: Domingo, 7: Sábado) 
         */
        dayOfWeek: (date: any): number => {
            const d = new Date(date);
            return isNaN(d.getTime()) ? 0 : d.getDay() + 1;
        },

        /** * $week: Número de semana del año 
         */
        week: (date: any): number => {
            const d = new Date(date);
            if (isNaN(d.getTime())) return 0;
            const startOfYear = new Date(d.getFullYear(), 0, 1);
            const diff = d.getTime() - startOfYear.getTime();
            const oneDay = 1000 * 60 * 60 * 24;
            return Math.floor(Math.floor(diff / oneDay) / 7) + 1;
        },

    };
}