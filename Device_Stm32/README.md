# Device_Stm32

Firmware for the STM32F103C8T6 sensor and actuator node. The STM32 is a
Modbus RTU slave on RS485: the master polls sensor values and writes the
controllable lamp and fan registers.

## Hardware pins

| Signal | STM32 pin | Notes |
| --- | --- | --- |
| DHT22 data | PA1 | Use the sensor's pull-up resistor |
| BH1750 SCL | PB6 | I2C1 |
| BH1750 SDA | PB7 | I2C1 |
| HC-SR522 output | PB0 | Active high |
| Main lamp output | PA2 | Active high |
| Fan output | PA3 | Active high |
| Motion indicator LED | PB1 | Active high; use a current-limiting resistor |
| RS485 transceiver DI | PA9 / USART1_TX | Connect to transceiver DI |
| RS485 transceiver RO | PA10 / USART1_RX | Connect to transceiver RO |
| RS485 DE and /RE | PB10 | Tie DE and /RE together; high = transmit, low = receive |

Connect the RS485 A/B pair to the bus and share ground between the STM32 and
transceiver. PB1 and PB10 are separate outputs so the motion indicator does not
affect the Modbus-controlled lamp.

## Modbus RTU

- Slave address: `1`
- Serial format: `9600 baud, 8 data bits, even parity, 1 stop bit (8E1)`
- STM32 HAL configuration: 9-bit word length plus even parity represents 8
  payload bits and one parity bit.
- Receive: DMA with UART IDLE detection; IDLE-delimited chunks are accumulated
  until a 5 ms quiet interval before CRC-16 checking and main-loop processing.
- Supported functions: `0x03` Read Holding Registers and `0x06` Write Single
  Register. The slave responds to requests; it does not send unsolicited
  telemetry.
- PDU register addresses are zero-based. The familiar `4xxxx` labels are shown
  alongside them below.

| PDU address | Conventional label | Access | Value |
| ---: | ---: | --- | --- |
| 0 | 40001 | Read | Temperature in 0.1 °C; signed 16-bit two's complement |
| 1 | 40002 | Read | Relative humidity in 0.1 %RH |
| 2 | 40003 | Read | Illuminance in lux, rounded to the nearest integer |
| 3 | 40004 | Read | Motion presence: `0` absent, `1` present |
| 4 | 40005 | Read/write | Main lamp: write `0` off or `1` on |
| 5 | 40006 | Read/write | Fan: write `0` off or `1` on |
| 6 | 40007 | Read | Status bitfield |

Status register bits:

| Bit | Meaning when set |
| ---: | --- |
| 0 | Most recent DHT22 read passed response and checksum validation |
| 1 | Most recent BH1750 read succeeded |
| 2 | A Modbus response transmission has failed since boot |
| 3 | A UART receive/restart error has occurred since boot |

Invalid register addresses return Modbus exception `0x02`; invalid values or
quantities return `0x03`; unsupported function codes return `0x01`. A bad CRC or
request for a different slave address is ignored.

## Runtime behavior

- DHT22 temperature/humidity and BH1750 illuminance are sampled every 3 seconds.
- Motion input is polled every 100 ms after a 3-second sensor startup period.
  A high input stable for 300 ms marks occupancy. Occupancy clears after the
  sensor's 5-second hold plus the ESP32 logic's 39-second off delay (about
  44 seconds after the last high sample).
- The separate PB1 indicator follows the occupancy state. The PA2 lamp remains
  under Modbus control and is not automatically changed by motion.
- Sensor values retain their last successful reading if a later sample fails;
  the status bits indicate whether the latest sample succeeded.

## Build

Open `MDK-ARM/Device_Stm32.uvprojx` in Keil MDK-ARM and build target
`Device_Stm32`. The CubeMX configuration is `Device_Stm32.ioc`.
