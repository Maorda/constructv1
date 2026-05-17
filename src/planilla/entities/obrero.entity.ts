import { Column, Relation } from "@database";
import { PrimaryKey } from "@database/decorators/primarykey.decorator";
import { Table } from "@database/decorators/table.decorator";
import { AsistenciaEntity } from "./asistencia.entity";

@Table('OBREROS') // Sobreescritura manual explícita
export class ObreroEntity {
    @PrimaryKey() // 👈 Registra 'dni' como la propiedad clave en SHEETS_PRIMARY_KEY
    @Column({ name: 'DNI', required: true }) // 👈 Alimenta SHEETS_COLUMN_DETAILS para getPrimaryKeyColumnName
    dni: string;

    @Column({ name: 'NOMBRES' })
    nombres: string;

    @Column({ name: 'APELLIDOS' })
    apellidos: string;

    @Column({ name: 'ESTADO_ELIMINADO', isDeleteControl: true })
    estadoEliminado: boolean; // Soporte nativo para tu borrado lógico del motor

    @Column({ name: 'JORNAL_DIARIO', type: 'currency' })
    jornalDiario: number = 0;

    @Relation({
        targetEntity: () => AsistenciaEntity,
        // No pasamos targetRepository, targetSheet ni localField de forma obligatoria.
        targetRepository: 'AsistenciaRepository',
        joinColumn: 'dni',
        onDelete: 'CASCADE',
        isMany: true
    })
    asistencias: AsistenciaEntity[];
}