# DHT22 Library
That library is intended for usage a DHT22 sensor which allow measure a temperature and humidity. DHT22 is
1wire sensor which require to use pin as input and output like also it require a microsecond delay, because that sensor works
with very specific timings. To create a microsecond delay is used TIM3.

## Getting started
Firs of all is require to set pin which is connected to the sensor as output or input. Then copy library files
to the project directory and include DHT22.h. That library is simply to use, just call init function:
```
void DHT22_Init(GPIO_TypeDef* Port, uint16_t Pin);
```
Example:
```
DHT22_Init(GPIOA, GPIO_PIN_9);
```
To read data from sensor use
```
uint8_t DHT22_Get_Data(uint16_t *Temp,uint16_t *Hum);
```
Example:
```
uint16_t temperature, humidity;
uint8_t status = DHT22_Get_Data(&temperature, &humidity);
```

`DHT22_Get_Data()` returns `DHT22_STATUS_OK` on success. Other return values
indicate a response timeout, checksum error, or invalid argument. On success,
temperature and humidity are returned in tenths (for example, `253` means
25.3 °C or %RH). Temperature's high bit is the sign bit; clear it to obtain
the magnitude.

The driver uses TIM3 for microsecond timing and applies a bounded timeout to
the sensor response and data pulses, so an absent sensor does not block the
main loop indefinitely.
