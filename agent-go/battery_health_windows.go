//go:build windows

package main

import (
	"bytes"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Battery health via IOCTL_BATTERY_QUERY_INFORMATION (kernel32 + setupapi).
//
// WMI Win32_Battery n'expose ni FullChargedCapacity ni CycleCount. La seule
// manière fiable est de passer par le device interface des batteries
// (GUID_DEVCLASS_BATTERY), demander un BatteryTag, puis interroger
// BATTERY_INFORMATION.
//
// Ciblage : cible amd64 + arm64 uniquement (32-bit non supporté). La taille
// de SP_DEVICE_INTERFACE_DETAIL_DATA_W est 8 sur ces ABI.

// GUID_DEVCLASS_BATTERY = 72631e54-78a4-11d0-bcf7-00aa00b7b32a
var batteryClassGUID = windows.GUID{
	Data1: 0x72631e54,
	Data2: 0x78a4,
	Data3: 0x11d0,
	Data4: [8]byte{0xbc, 0xf7, 0x00, 0xaa, 0x00, 0xb7, 0xb3, 0x2a},
}

const (
	digcfPresent         = 0x00000002
	digcfDeviceInterface = 0x00000010

	fileDeviceBattery = 0x00000029
	methodBuffered    = 0
	fileReadAccess    = 0x0001

	infoLevelBatteryInformation = 0 // BATTERY_QUERY_INFORMATION_LEVEL.BatteryInformation

	// SP_DEVICE_INTERFACE_DETAIL_DATA_W : sur 64-bit, le sizeof est 8.
	// Cf. distatus/battery, posts MSDN. Si on trouve un système où c'est
	// faux, on l'apprendra au déploiement (la query ne retournera rien).
	spDevIfDetailDataSize = 8
)

func ctlCode(deviceType, function, method, access uint32) uint32 {
	return (deviceType << 16) | (access << 14) | (function << 2) | method
}

var (
	iocBatteryQueryTag         = ctlCode(fileDeviceBattery, 0x10, methodBuffered, fileReadAccess)
	iocBatteryQueryInformation = ctlCode(fileDeviceBattery, 0x11, methodBuffered, fileReadAccess)
)

type spDeviceInterfaceData struct {
	cbSize             uint32
	interfaceClassGuid windows.GUID
	flags              uint32
	reserved           uintptr
}

type batteryQueryInformation struct {
	BatteryTag       uint32
	InformationLevel uint32
	AtRate           int32
}

type batteryInformationStruct struct {
	Capabilities        uint32
	Technology          byte
	Reserved            [3]byte
	Chemistry           [4]byte
	DesignedCapacity    uint32
	FullChargedCapacity uint32
	DefaultAlert1       uint32
	DefaultAlert2       uint32
	CriticalBias        uint32
	CycleCount          uint32
}

var (
	setupapi                             = windows.NewLazySystemDLL("setupapi.dll")
	procSetupDiGetClassDevsW             = setupapi.NewProc("SetupDiGetClassDevsW")
	procSetupDiEnumDeviceInterfaces      = setupapi.NewProc("SetupDiEnumDeviceInterfaces")
	procSetupDiGetDeviceInterfaceDetailW = setupapi.NewProc("SetupDiGetDeviceInterfaceDetailW")
	procSetupDiDestroyDeviceInfoList     = setupapi.NewProc("SetupDiDestroyDeviceInfoList")
)

// collectBatteryHealth enumère toutes les batteries présentes via setupapi,
// requête la première qui répond. Sur les machines sans batterie (desktop),
// retourne nil silencieusement.
func collectBatteryHealth() *BatteryHealth {
	hDev, _, _ := procSetupDiGetClassDevsW.Call(
		uintptr(unsafe.Pointer(&batteryClassGUID)),
		0, 0,
		uintptr(digcfPresent|digcfDeviceInterface))
	if hDev == 0 || hDev == ^uintptr(0) {
		return nil
	}
	defer procSetupDiDestroyDeviceInfoList.Call(hDev)

	for idx := uint32(0); ; idx++ {
		var did spDeviceInterfaceData
		did.cbSize = uint32(unsafe.Sizeof(did))

		ok, _, _ := procSetupDiEnumDeviceInterfaces.Call(
			hDev,
			0,
			uintptr(unsafe.Pointer(&batteryClassGUID)),
			uintptr(idx),
			uintptr(unsafe.Pointer(&did)),
		)
		if ok == 0 {
			break // ERROR_NO_MORE_ITEMS
		}

		path := getDeviceInterfaceDetail(hDev, &did)
		if path == "" {
			continue
		}
		if h := queryBatteryInfoFromPath(path); h != nil {
			return h
		}
	}
	return nil
}

func getDeviceInterfaceDetail(hDev uintptr, did *spDeviceInterfaceData) string {
	// 1er appel : récupère la taille requise (renvoie ERROR_INSUFFICIENT_BUFFER).
	var requiredSize uint32
	procSetupDiGetDeviceInterfaceDetailW.Call(
		hDev,
		uintptr(unsafe.Pointer(did)),
		0, 0,
		uintptr(unsafe.Pointer(&requiredSize)),
		0,
	)
	if requiredSize < spDevIfDetailDataSize {
		return ""
	}

	buf := make([]byte, requiredSize)
	*(*uint32)(unsafe.Pointer(&buf[0])) = spDevIfDetailDataSize

	r1, _, _ := procSetupDiGetDeviceInterfaceDetailW.Call(
		hDev,
		uintptr(unsafe.Pointer(did)),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(requiredSize),
		0, 0,
	)
	if r1 == 0 {
		return ""
	}

	// Le DevicePath commence après cbSize (DWORD = 4 octets) et est en UTF-16.
	pathBytes := buf[4:]
	if len(pathBytes) < 2 {
		return ""
	}
	chars := unsafe.Slice((*uint16)(unsafe.Pointer(&pathBytes[0])), len(pathBytes)/2)
	return windows.UTF16ToString(chars)
}

func queryBatteryInfoFromPath(devPath string) *BatteryHealth {
	pathW, err := windows.UTF16PtrFromString(devPath)
	if err != nil {
		return nil
	}
	handle, err := windows.CreateFile(
		pathW,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil,
		windows.OPEN_EXISTING,
		0, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(handle)

	// 1) Récupérer le BatteryTag (input = uint32 timeout = 0).
	var timeout uint32 = 0
	var tag uint32
	var bytesReturned uint32
	if err := windows.DeviceIoControl(
		handle, iocBatteryQueryTag,
		(*byte)(unsafe.Pointer(&timeout)), uint32(unsafe.Sizeof(timeout)),
		(*byte)(unsafe.Pointer(&tag)), uint32(unsafe.Sizeof(tag)),
		&bytesReturned, nil,
	); err != nil || tag == 0 {
		return nil
	}

	// 2) Demander BATTERY_INFORMATION (level 0).
	bqi := batteryQueryInformation{
		BatteryTag:       tag,
		InformationLevel: infoLevelBatteryInformation,
	}
	var bi batteryInformationStruct
	if err := windows.DeviceIoControl(
		handle, iocBatteryQueryInformation,
		(*byte)(unsafe.Pointer(&bqi)), uint32(unsafe.Sizeof(bqi)),
		(*byte)(unsafe.Pointer(&bi)), uint32(unsafe.Sizeof(bi)),
		&bytesReturned, nil,
	); err != nil {
		return nil
	}
	if bi.DesignedCapacity == 0 || bi.FullChargedCapacity == 0 {
		// Cellule récente non-calibrée ou firmware peu coopératif. On
		// considère que la donnée n'est pas exploitable.
		return nil
	}

	chem := bi.Chemistry[:]
	if i := bytes.IndexByte(chem, 0); i >= 0 {
		chem = chem[:i]
	}

	healthPct := float64(bi.FullChargedCapacity) / float64(bi.DesignedCapacity) * 100
	// Floor à 100% : certaines batteries neuves rapportent FullCharge > Designed
	// (calibrage initial), 105% n'a pas de sens à exposer.
	if healthPct > 100 {
		healthPct = 100
	}

	return &BatteryHealth{
		HealthPct:     round2(healthPct),
		DesignedMWh:   bi.DesignedCapacity,
		FullChargeMWh: bi.FullChargedCapacity,
		CycleCount:    bi.CycleCount,
		Chemistry:     string(chem),
	}
}
