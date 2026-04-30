import { Column } from "../decorators/column.decorator";

export class BaseEntity {

    @Column({
        name: 'id',
        type: 'string',
        isPrimaryKey: true,
        isAutoIncrement: true
    })
    id: number;

    @Column({
        name: 'activo',
        type: 'boolean',
        isDeleteControl: true,
        default: true
    })
    activo: boolean;
}