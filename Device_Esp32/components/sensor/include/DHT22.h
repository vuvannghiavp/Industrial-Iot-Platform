/*

	DHT22 temperature sensor driver

*/

#ifndef DHT22_H_
#define DHT22_H_

// == function prototypes =======================================

void 	setDHTgpio(int gpio);
void 	errorHandler(int response);
int 	readDHT();
float 	getHumidity();
float 	getTemperature();

#endif
